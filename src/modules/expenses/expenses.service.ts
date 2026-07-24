import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common';
import { InMemoryDatabase } from '../../database/in-memory.database';
import { EXPENSES_SPEC, TRANSACTIONS_SPEC } from '../../database/calendar-asset-specs';
import { CalendarUnitOfWork } from '../../database/calendar-unit-of-work.service';
import { PostgresCollectionStore } from '../../database/postgres-collection.store';
import { AuditService } from '../audit/audit.service';
import { Expense, EXPENSES } from './expense.entity';
import { Transaction } from '../transactions/transaction.entity';
import { CreateExpenseDto } from './dto/create-expense.dto';
import { UpdateExpenseDto } from './dto/update-expense.dto';

@Injectable()
export class ExpensesService implements OnModuleInit {
  // [TBO-58 P2] 도메인 command 1줄 로그 — payments.service [money] 패턴 확장(allowlist: id·상태·금액만)
  private readonly moneyLog = new Logger('money');
  constructor(
    private readonly db: InMemoryDatabase,
    private readonly store: PostgresCollectionStore,
    private readonly unitOfWork: CalendarUnitOfWork,
    private readonly audit: AuditService, // [감사 전수 2026-07-16] 지출 승인/반려·원장 이력(대표 지시)
  ) {}

  // 데모 지출 시드 — 프론트 목데이터 이관(FK 없음). 승인 대기 1건 → 지출 탭 배지 동작.
  async onModuleInit(): Promise<void> {
    await this.store.hydrate<Expense>(EXPENSES_SPEC);
  }

  findAll(): Expense[] {
    return this.db.findAll<Expense>(EXPENSES);
  }

  /** [TBO-54 C2] 목록/상세 READ = DB 권위. */
  listDb(): Promise<Expense[]> {
    return this.store.findActive<Expense>(EXPENSES_SPEC, { orderBy: { field: 'id' } });
  }

  async getDb(id: number): Promise<Expense> {
    const [row] = await this.store.findActive<Expense>(EXPENSES_SPEC, { where: { id } as Partial<Expense>, limit: 1 });
    if (!row) throw new NotFoundException(`Expense ${id} not found`);
    return row;
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
      this.moneyLog.log(`action=create expense=${row.id} actor=${actorId ?? 0} amount=${row.amount} result=requested`);
      return row;
    });
  }

  // [TBO-58 P2 2026-07-24] 오기입 정정 — requested만 수정 가능(approved는 원장 출금이 이미 기록,
  //  rejected는 반려 이력 보존 → 새 요청으로). CAS(updateIf status=requested)로 승인 경합 차단.
  async update(id: number, dto: UpdateExpenseDto, actorId?: number): Promise<Expense> {
    return this.unitOfWork.run(async () => {
      const row = await this.getDb(id); // DB 권위 재조회(메모리 스테일 차단)
      if (row.status !== 'requested')
        throw new BadRequestException(`수정 불가 상태(${row.status}) — requested만 수정 가능(승인된 지출은 원장 정합을 위해 불변)`);
      const patch: Partial<Expense> = {};
      for (const key of ['category', 'title', 'amount', 'spentAt', 'vendor', 'memo', 'receiptUrl'] as const) {
        if (dto[key] !== undefined) (patch as Record<string, unknown>)[key] = dto[key];
      }
      if (Object.keys(patch).length === 0) throw new BadRequestException('수정할 필드가 없습니다.');
      const updated = await this.store.updateIf<Expense>(EXPENSES_SPEC, id, { status: 'requested' }, patch);
      if (!updated) {
        this.moneyLog.warn(`action=update expense=${id} actor=${actorId ?? 0} result=conflict(cas)`);
        throw new ConflictException('지출 상태가 이미 변경되었습니다. 새로고침 후 다시 시도해 주세요.');
      }
      if (actorId != null) {
        await this.audit.log({
          entity: 'expenses', entityId: id, action: 'update', actorId,
          changes: this.audit.diffOf(row, updated), // before/after diff — 정정 이력(대표 지시 "이력만 남기면 됨")
        });
      }
      this.moneyLog.log(`action=update expense=${id} actor=${actorId ?? 0} fields=${Object.keys(patch).join(',')} result=amended`);
      return updated;
    });
  }

  // [TBO-58 P2 2026-07-24] 철회 = soft delete — requested만(approved는 원장 기록 존재 → 불가,
  //  rejected는 반려 이력 보존). 목록/집계에서 사라지고 DB엔 deleted_at 이력이 남는다.
  async withdraw(id: number, actorId?: number): Promise<{ id: number; deleted: true }> {
    return this.unitOfWork.run(async () => {
      const row = await this.getDb(id);
      if (row.status !== 'requested')
        throw new BadRequestException(`철회 불가 상태(${row.status}) — requested만 철회 가능`);
      const removed = await this.store.remove(EXPENSES_SPEC, id, actorId);
      if (!removed) {
        this.moneyLog.warn(`action=withdraw expense=${id} actor=${actorId ?? 0} result=conflict`);
        throw new ConflictException('지출이 이미 변경/삭제되었습니다. 새로고침 후 다시 시도해 주세요.');
      }
      if (actorId != null) {
        await this.audit.log({
          entity: 'expenses', entityId: id, action: 'delete', actorId,
          changes: { title: { before: row.title }, amount: { before: row.amount }, status: { before: row.status } },
        });
      }
      this.moneyLog.log(`action=withdraw expense=${id} actor=${actorId ?? 0} amount=${row.amount} result=withdrawn`);
      return { id, deleted: true as const };
    });
  }

  async approve(id: number, actorId?: number): Promise<Expense> {
    // [원자성] 지출 승인 + 통합 원장 출금 1줄이 함께(원장 누락 방지)
    return this.unitOfWork.run(async () => {
      // [감사 H1 해소 2026-07-24] 메모리 미러(findOne) → DB 권위 재조회 — 교차 인스턴스에서 정정된
      //  금액을 스테일로 원장에 싣던 구멍(payments markPaid와 동일 규약으로 정렬).
      const row = await this.getDb(id);
      // [H2] 상태 가드 — 재승인 시 원장 출금 중복, approved→반려 시 원장 불일치 방지(코드리뷰 2026-07-02)
      if (row.status !== 'requested') throw new BadRequestException(`승인 불가 상태(${row.status}) — requested만 승인 가능`);
      const updated = await this.store.updateIf<Expense>(EXPENSES_SPEC, id, { status: 'requested' }, { status: 'approved' });
      if (!updated) throw new ConflictException('지출 상태가 이미 변경되었습니다. 새로고침 후 다시 시도해 주세요.');
      // [자산화 점검 2026-07-02] 지출 승인 = 통합 원장(transactions)에 출금 1줄(TBO-03 "승인 후 출금 반영").
      //  이전엔 상태만 approved로 바뀌고 원장 미기록 → 지출 집계(자산)에서 누락되던 갭.
      const tx = await this.store.insert<Transaction>(TRANSACTIONS_SPEC, {
        direction: 'out',
        category: 'expense',
        label: `지출 승인 — ${updated.title} (${updated.category})`,
        amount: updated.amount, // [감사 H1] 원장 금액 = CAS 반환 행(DB 권위)만 — payments 규약 동일
        occurredAt: new Date().toISOString(),
        expenseId: id,
      });
      // [감사 전수 2026-07-16] 승인 전환 + 원장 출금 각 1건 — 대표 결정: 원장도 감사 대상.
      if (actorId != null) {
        await this.audit.log({
          entity: 'expenses', entityId: id, action: 'approve', actorId,
          changes: { status: { before: 'requested', after: 'approved' }, amount: { after: updated.amount } },
        });
        await this.audit.log({
          entity: 'transactions', entityId: tx.id, action: 'create', actorId,
          changes: { direction: { after: 'out' }, category: { after: 'expense' }, amount: { after: tx.amount } },
        });
      }
      // [TBO-58 P2] 승인 + 원장 출금을 한 줄로 — "원장에 몇 번으로 실렸는지" 로그만으로 재구성
      this.moneyLog.log(`action=approve expense=${id} actor=${actorId ?? 0} amount=${updated.amount} ledgerTx=${tx.id} result=approved`);
      return updated;
    });
  }

  async reject(id: number, reason: string, actorId?: number): Promise<Expense> { // [Q2] 사유 필수
    return this.unitOfWork.run(async () => {
    const row = await this.getDb(id); // [감사 H1] DB 권위 재조회(approve와 동일 규약)
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
    this.moneyLog.log(`action=reject expense=${id} actor=${actorId ?? 0} result=rejected`); // [TBO-58 P2]
    return rejected;
    });
  }
}
