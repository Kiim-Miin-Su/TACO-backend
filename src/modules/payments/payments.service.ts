import { TimedModuleInit } from '../../common/performance-timing';
import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common';
import { InMemoryDatabase } from '../../database/in-memory.database';
import {
  ENROLLMENTS_SPEC, PARENTS_SPEC, PARENT_STUDENT_RELATIONS_SPEC, PAYMENTS_SPEC, STUDENTS_SPEC, TRANSACTIONS_SPEC,
} from '../../database/calendar-asset-specs';
import { CalendarUnitOfWork } from '../../database/calendar-unit-of-work.service';
import { PostgresCollectionStore } from '../../database/postgres-collection.store';
import { AuditService } from '../audit/audit.service';
import { Payment, PAYMENTS } from './payment.entity';
import { Transaction } from '../transactions/transaction.entity';
import { CreatePaymentDto } from './dto/create-payment.dto';
import { UpdatePaymentDto } from './dto/update-payment.dto';
import { Student } from '../students/student.entity';
import { Enrollment } from '../enrollments/enrollment.entity';
import { Parent, ParentStudent } from '../parents/parent.entity';

/**
 * [TBO-53 C1 2026-07-23] 결제 command의 DB 권위 완결 — TBO-50 P0-2 이행.
 *  표준 순서(FABLE §3.3): payment advisory lock → **DB 재조회**(hydrate 미러 아님) → 가드 →
 *  `{status, amount}` CAS → 같은 tx에서 원장(transactions)·audit — 원장 금액은 **CAS 반환 행**만 사용.
 *  종전엔 금액·관계를 부팅 hydrate 메모리로 판정해, 다른 인스턴스가 금액을 정정한 뒤 낡은 인스턴스가
 *  수납하면 paid_amount·원장이 과거 금액으로 기록될 수 있었다(2-instance race e2e가 회귀 가드).
 *  READ 목록/상세의 DB repository 전환은 C2(SSOT-P0) 범위.
 */
@TimedModuleInit()
@Injectable()
export class PaymentsService implements OnModuleInit {
  // [TBO-54 C2 대표 지시 콘솔 로깅] 머니 전이 관측 — allowlist(action·id·actor·금액·결과)만, PII 0.
  private readonly moneyLog = new Logger('money');

  constructor(
    private readonly db: InMemoryDatabase,
    private readonly store: PostgresCollectionStore,
    private readonly unitOfWork: CalendarUnitOfWork,
    private readonly audit: AuditService, // [감사 전수 2026-07-16] 수납·환불·원장 이력(대표 지시)
  ) {}

  async onModuleInit(): Promise<void> {
    await this.store.hydrate<Payment>(PAYMENTS_SPEC);
  }

  findAll(): Payment[] {
    return this.db.findAll<Payment>(PAYMENTS);
  }

  findOne(id: number): Payment {
    const row = this.db.findById<Payment>(PAYMENTS, id);
    if (!row) throw new NotFoundException(`Payment ${id} not found`);
    return row;
  }

  /** [TBO-54 C2] 목록/상세 READ = DB 권위(다른 인스턴스의 청구·수납·환불 즉시 반영). */
  listDb(): Promise<Payment[]> {
    return this.store.findActive<Payment>(PAYMENTS_SPEC, { orderBy: { field: 'id' } });
  }

  getDb(id: number): Promise<Payment> {
    return this.paymentFromDb(id);
  }

  /** [TBO-53 C1] lock 뒤 판정용 DB 재조회 — PG 미가용(메모리 모드)일 땐 메모리 행이 그대로 권위. */
  private async paymentFromDb(id: number): Promise<Payment> {
    const [row] = await this.store.findActive<Payment>(PAYMENTS_SPEC, { where: { id } as Partial<Payment>, limit: 1 });
    if (!row) throw new NotFoundException(`Payment ${id} not found`);
    return row;
  }

  /** [TBO-53 C1] 관계 4종 DB 재검증 — 삭제/불일치는 400(물리 FK가 최후 방어선). */
  private async assertRelationsInDb(input: { studentId: number; enrollmentId?: number | null; payerParentId?: number | null }): Promise<void> {
    const [student] = await this.store.findActive<Student>(STUDENTS_SPEC, { where: { id: input.studentId } as Partial<Student>, limit: 1 });
    if (!student) throw new BadRequestException(`studentId ${input.studentId} 없음(존재하지 않는 학생)`);
    if (input.enrollmentId != null) {
      const [enrollment] = await this.store.findActive<Enrollment>(ENROLLMENTS_SPEC, { where: { id: input.enrollmentId } as Partial<Enrollment>, limit: 1 });
      if (!enrollment) throw new BadRequestException(`enrollmentId ${input.enrollmentId} 없음(존재하지 않는 수강)`);
      if (enrollment.studentId !== input.studentId) {
        throw new BadRequestException(`enrollmentId ${input.enrollmentId}는 studentId ${input.studentId}의 수강이 아닙니다.`);
      }
    }
    if (input.payerParentId != null) {
      const [parent] = await this.store.findActive<Parent>(PARENTS_SPEC, { where: { id: input.payerParentId } as Partial<Parent>, limit: 1 });
      if (!parent) throw new BadRequestException(`payerParentId ${input.payerParentId} 없음(존재하지 않는 보호자)`);
      const linked = await this.store.findActive<ParentStudent>(PARENT_STUDENT_RELATIONS_SPEC, {
        where: { parentId: input.payerParentId, studentId: input.studentId } as Partial<ParentStudent>, limit: 1,
      });
      if (!linked.length) {
        throw new BadRequestException(`payerParentId ${input.payerParentId}는 studentId ${input.studentId}와 연결되지 않았습니다.`);
      }
    }
  }

  // 결제는 옵셔널 — 청구서만 먼저 만들 수 있음(status=pending). 관계 검증은 tx 안 DB 기준(C1).
  async create(dto: CreatePaymentDto, actorId?: number): Promise<Payment> {
    return this.unitOfWork.run(async () => {
      await this.assertRelationsInDb(dto);
      const row = await this.store.insert<Payment>(PAYMENTS_SPEC, {
        studentId: dto.studentId,
        enrollmentId: dto.enrollmentId,
        payerParentId: dto.payerParentId,
        amount: dto.amount,
        paidAmount: 0,
        status: 'pending',
        paymentMethod: dto.paymentMethod,
        dueAt: dto.dueAt,
      });
      // [감사 전수 2026-07-16] 청구 생성 이력 — 금액·대상(학생 id)만(연락처 등 PII 없음).
      if (actorId != null) {
        await this.audit.log({
          entity: 'payments', entityId: row.id, action: 'create', actorId,
          changes: { amount: { after: row.amount }, studentId: { after: row.studentId } },
        });
      }
      return row;
    });
  }

  // 청구 정정. 수납 완료/환불 건은 원장 보존을 위해 메모만 정정한다. [C1] lock+DB 재조회+status CAS.
  async update(id: number, dto: UpdatePaymentDto, actorId?: number): Promise<Payment> {
    return this.unitOfWork.run(async () => {
      await this.unitOfWork.lockTargets([{ kind: 'payment', id }]);
      const row = await this.paymentFromDb(id);
      if (row.status !== 'pending' && row.status !== 'overdue'
        && (dto.amount !== undefined || dto.paymentMethod !== undefined || dto.dueAt !== undefined)) {
        throw new BadRequestException(`정정 불가 상태(${row.status}) — 완료된 수납의 금액·수단·기한은 원장 취소/재처리로 변경해야 합니다.`);
      }
      // 상태 CAS — 정정과 수납이 겹치면 한쪽만 성공(수납 뒤 금액 정정이 원장을 오염시키지 않도록).
      const after = await this.store.updateIf<Payment>(PAYMENTS_SPEC, id, { status: row.status }, { ...dto });
      if (!after) {
        this.moneyLog.warn(`action=update payment=${id} actor=${actorId ?? 0} result=conflict(cas)`);
        throw new ConflictException('청구 상태가 이미 변경되었습니다. 새로고침 후 다시 시도해 주세요.');
      }
      if (dto.amount !== undefined && dto.amount !== row.amount) {
        this.moneyLog.log(`action=update payment=${id} actor=${actorId ?? 0} amount=${row.amount}->${after.amount} result=amended`);
      }
      // [감사 전수 2026-07-16] 청구 정정 diff 이력 — DB before/after 기준.
      if (actorId != null) {
        await this.audit.log({ entity: 'payments', entityId: id, action: 'update', actorId, changes: this.audit.diffOf(row, after) });
      }
      return after;
    });
  }

  async markPaid(id: number, actorId?: number): Promise<Payment> {
    // [원자성] 수납 상태 갱신 + 통합 원장 입금 1줄이 함께(원장 누락 방지)
    return this.unitOfWork.run(async () => {
      await this.unitOfWork.lockTargets([{ kind: 'payment', id }]);
      const row = await this.paymentFromDb(id); // [C1] lock 뒤 DB 재조회 — 메모리 판정 금지
      // [H1] 멱등 가드 — 이중 클릭/재시도로 원장 입금이 중복 기록되는 것 방지(코드리뷰 2026-07-02)
      if (row.status === 'paid') throw new BadRequestException('이미 수납 완료된 청구입니다.');
      if (row.status !== 'pending' && row.status !== 'overdue') {
        throw new BadRequestException(`수납 불가 상태(${row.status}) — pending/overdue만 수납 가능`);
      }
      await this.assertRelationsInDb(row); // 삭제된 학생/수강/보호자 대상 수납 차단(DB 기준)
      const now = new Date().toISOString();
      // [C1] {status, amount} CAS — 다른 인스턴스의 금액 정정과 겹치면 반드시 409(과거 금액 수납 차단).
      const updated = await this.store.updateIf<Payment>(PAYMENTS_SPEC, id, { status: row.status, amount: row.amount }, {
        status: 'paid',
        paidAmount: row.amount,
        paidAt: now,
      });
      if (!updated) {
        this.moneyLog.warn(`action=markPaid payment=${id} actor=${actorId ?? 0} result=conflict(cas)`);
        throw new ConflictException('청구 상태가 이미 변경되었습니다. 새로고침 후 다시 시도해 주세요.');
      }
      // [자산화 점검 2026-07-02] 수납 = 통합 원장(transactions)에 입금 1줄 — payouts.pay와 동일 패턴.
      //  [C1] 원장 금액은 CAS **반환 행**(DB 권위)만 사용 — payment·ledger 동일 스냅샷 보장.
      const tx = await this.store.insert<Transaction>(TRANSACTIONS_SPEC, {
        direction: 'in',
        category: 'enrollment',
        label: `수강료 수납 — 학생 ${updated.studentId}${updated.enrollmentId != null ? ` · 수강 ${updated.enrollmentId}` : ''}`,
        amount: updated.paidAmount ?? updated.amount, // CAS 반환 행(DB 권위) — paid 직후라 항상 paidAmount
        occurredAt: now,
        paymentId: id,
      });
      // [감사 전수 2026-07-16] 수납 전환 + 원장 입금 각 1건 — 대표 결정: 원장도 감사 대상.
      if (actorId != null) {
        await this.audit.log({
          entity: 'payments', entityId: id, action: 'status_change', actorId,
          changes: { status: { before: row.status, after: 'paid' }, paidAmount: { after: updated.paidAmount } },
        });
        await this.audit.log({
          entity: 'transactions', entityId: tx.id, action: 'create', actorId,
          changes: { direction: { after: 'in' }, category: { after: 'enrollment' }, amount: { after: tx.amount } },
        });
      }
      this.moneyLog.log(`action=markPaid payment=${id} actor=${actorId ?? 0} amount=${updated.paidAmount} ledgerTx=${tx.id} result=paid`);
      return updated;
    });
  }

  // [원장 완결성 2026-07-03] 환불 — 수납의 역방향 출금을 원장에 기록(실DB 가정 감사에서 발견된 공백).
  //  paid 상태에서만 가능(멱등 — 재클릭/미수납 환불 400), 전액 환불(부분 환불은 partial_refund 확장 여지).
  async refund(id: number, actorId?: number): Promise<Payment> {
    return this.unitOfWork.run(async () => {
      await this.unitOfWork.lockTargets([{ kind: 'payment', id }]);
      const row = await this.paymentFromDb(id); // [C1] lock 뒤 DB 재조회
      if (row.status !== 'paid') throw new BadRequestException('수납 완료(paid) 상태에서만 환불할 수 있습니다.');
      const now = new Date().toISOString();
      // [C1] {status, paidAmount} CAS — 환불 금액은 실제 수납 금액(DB)과 반드시 일치.
      const updated = await this.store.updateIf<Payment>(PAYMENTS_SPEC, id, { status: 'paid', paidAmount: row.paidAmount }, { status: 'refunded' });
      if (!updated) {
        this.moneyLog.warn(`action=refund payment=${id} actor=${actorId ?? 0} result=conflict(cas)`);
        throw new ConflictException('청구 상태가 이미 변경되었습니다. 새로고침 후 다시 시도해 주세요.');
      }
      const tx = await this.store.insert<Transaction>(TRANSACTIONS_SPEC, {
        direction: 'out',
        category: 'refund',
        label: `수강료 환불 — 학생 ${updated.studentId}${updated.enrollmentId != null ? ` · 수강 ${updated.enrollmentId}` : ''}`,
        amount: updated.paidAmount ?? updated.amount, // [C1] CAS 반환 행 기준(원장=결제 동일 스냅샷)
        occurredAt: now,
        paymentId: id, // 역참조: 어느 수납의 환불인지(원장 조인 키)
      });
      // [감사 전수 2026-07-16] 환불 전환 + 원장 출금 각 1건.
      if (actorId != null) {
        await this.audit.log({
          entity: 'payments', entityId: id, action: 'status_change', actorId,
          changes: { status: { before: 'paid', after: 'refunded' } },
        });
        await this.audit.log({
          entity: 'transactions', entityId: tx.id, action: 'create', actorId,
          changes: { direction: { after: 'out' }, category: { after: 'refund' }, amount: { after: tx.amount } },
        });
      }
      this.moneyLog.log(`action=refund payment=${id} actor=${actorId ?? 0} amount=${tx.amount} ledgerTx=${tx.id} result=refunded`);
      return updated;
    });
  }
}
