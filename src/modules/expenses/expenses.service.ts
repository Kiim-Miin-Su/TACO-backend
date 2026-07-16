import { BadRequestException, ConflictException, Injectable, NotFoundException, OnModuleInit } from '@nestjs/common';
import { InMemoryDatabase } from '../../database/in-memory.database';
import { EXPENSES_SPEC, TRANSACTIONS_SPEC } from '../../database/calendar-asset-specs';
import { CalendarUnitOfWork } from '../../database/calendar-unit-of-work.service';
import { PostgresCollectionStore } from '../../database/postgres-collection.store';
import { AuditService } from '../audit/audit.service';
import { Expense, EXPENSES } from './expense.entity';
import { Transaction } from '../transactions/transaction.entity';
import { CreateExpenseDto } from './dto/create-expense.dto';

@Injectable()
export class ExpensesService implements OnModuleInit {
  constructor(
    private readonly db: InMemoryDatabase,
    private readonly store: PostgresCollectionStore,
    private readonly unitOfWork: CalendarUnitOfWork,
    private readonly audit: AuditService, // [감사 전수 2026-07-16] 지출 승인/반려·원장 이력(대표 지시)
  ) {}

  // 데모 지출 시드 — 프론트 목데이터 이관(FK 없음). 승인 대기 1건 → 지출 탭 배지 동작.
  async onModuleInit(): Promise<void> {
    const hydrated = await this.store.hydrate<Expense>(EXPENSES_SPEC);
    if (hydrated.length) return;
    await this.store.seed<Expense>(EXPENSES_SPEC, [
      { id: 1, category: 'supplies', title: '화이트보드 마커 외', amount: 86000, spentAt: '2026-06-22', vendor: '오피스디포', status: 'approved' },
      { id: 2, category: 'books', title: 'SAT 교재 30부', amount: 450000, spentAt: '2026-06-18', vendor: '교보문고', status: 'approved' },
      { id: 3, category: 'equipment', title: '빔프로젝터 1대', amount: 680000, spentAt: '2026-06-15', vendor: '전자랜드', status: 'approved' },
      { id: 4, category: 'utility', title: '6월 전기·인터넷', amount: 240000, spentAt: '2026-06-10', status: 'approved' },
      { id: 5, category: 'meal', title: '강사 회식', amount: 180000, spentAt: '2026-06-20', status: 'requested' },
    ]);
  }

  findAll(): Expense[] {
    return this.db.findAll<Expense>(EXPENSES);
  }

  findOne(id: number): Expense {
    const row = this.db.findById<Expense>(EXPENSES, id);
    if (!row) throw new NotFoundException(`Expense ${id} not found`);
    return row;
  }

  // 지출은 요청(requested)으로 생성 → super_admin 승인 필요
  async create(dto: CreateExpenseDto, actorId?: number): Promise<Expense> {
    return this.unitOfWork.run(async () => {
      const row = await this.store.insert<Expense>(EXPENSES_SPEC, {
        category: dto.category,
        title: dto.title,
        amount: dto.amount,
        spentAt: dto.spentAt,
        vendor: dto.vendor,
        memo: dto.memo,
        receiptUrl: dto.receiptUrl,
        status: 'requested',
      });
      // [감사 전수 2026-07-16] 지출 요청 생성 이력.
      if (actorId != null) {
        await this.audit.log({
          entity: 'expenses', entityId: row.id, action: 'create', actorId,
          changes: { title: { after: row.title }, amount: { after: row.amount } },
        });
      }
      return row;
    });
  }

  async approve(id: number, actorId?: number): Promise<Expense> {
    // [원자성] 지출 승인 + 통합 원장 출금 1줄이 함께(원장 누락 방지)
    return this.unitOfWork.run(async () => {
      const row = this.findOne(id);
      // [H2] 상태 가드 — 재승인 시 원장 출금 중복, approved→반려 시 원장 불일치 방지(코드리뷰 2026-07-02)
      if (row.status !== 'requested') throw new BadRequestException(`승인 불가 상태(${row.status}) — requested만 승인 가능`);
      const updated = await this.store.updateIf<Expense>(EXPENSES_SPEC, id, { status: 'requested' }, { status: 'approved' });
      if (!updated) throw new ConflictException('지출 상태가 이미 변경되었습니다. 새로고침 후 다시 시도해 주세요.');
      // [자산화 점검 2026-07-02] 지출 승인 = 통합 원장(transactions)에 출금 1줄(TBO-03 "승인 후 출금 반영").
      //  이전엔 상태만 approved로 바뀌고 원장 미기록 → 지출 집계(자산)에서 누락되던 갭.
      const tx = await this.store.insert<Transaction>(TRANSACTIONS_SPEC, {
        direction: 'out',
        category: 'expense',
        label: `지출 승인 — ${row.title} (${row.category})`,
        amount: row.amount,
        occurredAt: new Date().toISOString(),
        expenseId: id,
      });
      // [감사 전수 2026-07-16] 승인 전환 + 원장 출금 각 1건 — 대표 결정: 원장도 감사 대상.
      if (actorId != null) {
        await this.audit.log({
          entity: 'expenses', entityId: id, action: 'approve', actorId,
          changes: { status: { before: 'requested', after: 'approved' }, amount: { after: row.amount } },
        });
        await this.audit.log({
          entity: 'transactions', entityId: tx.id, action: 'create', actorId,
          changes: { direction: { after: 'out' }, category: { after: 'expense' }, amount: { after: tx.amount } },
        });
      }
      return updated;
    });
  }

  async reject(id: number, reason: string, actorId?: number): Promise<Expense> { // [Q2] 사유 필수
    return this.unitOfWork.run(async () => {
    const row = this.findOne(id);
    // [H2] approved 지출을 반려하면 이미 기록된 원장 출금과 어긋남 — requested만 반려 가능
    if (row.status !== 'requested') throw new BadRequestException(`반려 불가 상태(${row.status}) — requested만 반려 가능`);
    // [자산화 2026-07-03] 반려 사유를 서버에 저장(v0.1.12 Expense.rejectedReason) —
    //  이전엔 zustand expenseRejectReasons(브라우저 휘발)에만 있어 실DB 이관 시 유실되던 갭.
    const rejected = await this.store.updateIf<Expense>(
      EXPENSES_SPEC,
      id,
      { status: 'requested' },
      { status: 'rejected', rejectedReason: reason },
    );
    if (!rejected) throw new ConflictException('지출 상태가 이미 변경되었습니다. 새로고침 후 다시 시도해 주세요.');
    // [감사 전수 2026-07-16] 반려 이력(사유 포함).
    if (actorId != null) {
      await this.audit.log({
        entity: 'expenses', entityId: id, action: 'reject', actorId,
        changes: { status: { before: 'requested', after: 'rejected' } }, reason,
      });
    }
    return rejected;
    });
  }
}
