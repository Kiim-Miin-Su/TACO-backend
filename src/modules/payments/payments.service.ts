import { BadRequestException, ConflictException, Injectable, NotFoundException, OnModuleInit } from '@nestjs/common';
import { InMemoryDatabase } from '../../database/in-memory.database';
import { PAYMENTS_SPEC, TRANSACTIONS_SPEC } from '../../database/calendar-asset-specs';
import { CalendarUnitOfWork } from '../../database/calendar-unit-of-work.service';
import { PostgresCollectionStore } from '../../database/postgres-collection.store';
import { Payment, PAYMENTS } from './payment.entity';
import { Transaction } from '../transactions/transaction.entity';
import { CreatePaymentDto } from './dto/create-payment.dto';
import { UpdatePaymentDto } from './dto/update-payment.dto';
import { Student, STUDENTS } from '../students/student.entity';
import { Enrollment, ENROLLMENTS } from '../enrollments/enrollment.entity';
import { Parent, ParentStudent, PARENTS, PARENT_STUDENTS } from '../parents/parent.entity';

@Injectable()
export class PaymentsService implements OnModuleInit {
  constructor(
    private readonly db: InMemoryDatabase,
    private readonly store: PostgresCollectionStore,
    private readonly unitOfWork: CalendarUnitOfWork,
  ) {}

  // 데모 결제 시드 — 프론트 목데이터 이관. enrollmentId→enrollments, studentId→students(무결성).
  // 미수(pending+dueAt) 2건 → 결제 탭 배지가 백엔드 기준으로 동작.
  async onModuleInit(): Promise<void> {
    const hydrated = await this.store.hydrate<Payment>(PAYMENTS_SPEC);
    if (hydrated.length) return;
    await this.store.seed<Payment>(PAYMENTS_SPEC, [
      { id: 1, enrollmentId: 1, studentId: 1, amount: 480000, paidAmount: 480000, status: 'paid', paymentMethod: 'card', paidAt: '2026-06-24' },
      { id: 2, enrollmentId: 2, studentId: 2, amount: 520000, paidAmount: 520000, status: 'paid', paymentMethod: 'transfer', paidAt: '2026-06-23' },
      { id: 3, enrollmentId: 3, studentId: 4, amount: 480000, paidAmount: 0, status: 'pending', dueAt: '2026-06-30' },
      { id: 4, enrollmentId: 4, studentId: 1, amount: 420000, paidAmount: 0, status: 'pending', dueAt: '2026-06-28' },
      { id: 5, enrollmentId: 3, studentId: 4, amount: 480000, paidAmount: 480000, status: 'paid', paymentMethod: 'card', paidAt: '2026-06-10' },
      { id: 6, enrollmentId: 4, studentId: 1, amount: 420000, paidAmount: 420000, status: 'paid', paymentMethod: 'transfer', paidAt: '2026-05-28' },
      { id: 7, enrollmentId: 2, studentId: 2, amount: 520000, paidAmount: 520000, status: 'paid', paymentMethod: 'card', paidAt: '2026-05-15' },
    ]);
  }

  findAll(): Payment[] {
    return this.db.findAll<Payment>(PAYMENTS);
  }

  findOne(id: number): Payment {
    const row = this.db.findById<Payment>(PAYMENTS, id);
    if (!row) throw new NotFoundException(`Payment ${id} not found`);
    return row;
  }

  // 결제는 옵셔널 — 청구서만 먼저 만들 수 있음(status=pending)
  async create(dto: CreatePaymentDto): Promise<Payment> {
    if (!this.db.findById<Student>(STUDENTS, dto.studentId)) {
      throw new BadRequestException(`studentId ${dto.studentId} 없음(존재하지 않는 학생)`);
    }
    if (dto.enrollmentId != null) {
      const enrollment = this.db.findById<Enrollment>(ENROLLMENTS, dto.enrollmentId);
      if (!enrollment) throw new BadRequestException(`enrollmentId ${dto.enrollmentId} 없음(존재하지 않는 수강)`);
      if (enrollment.studentId !== dto.studentId) {
        throw new BadRequestException(`enrollmentId ${dto.enrollmentId}는 studentId ${dto.studentId}의 수강이 아닙니다.`);
      }
    }
    if (dto.payerParentId != null) {
      if (!this.db.findById<Parent>(PARENTS, dto.payerParentId)) {
        throw new BadRequestException(`payerParentId ${dto.payerParentId} 없음(존재하지 않는 보호자)`);
      }
      const linked = this.db.findBy<ParentStudent>(
        PARENT_STUDENTS,
        (row) => row.parentId === dto.payerParentId && row.studentId === dto.studentId,
      );
      if (!linked.length) {
        throw new BadRequestException(`payerParentId ${dto.payerParentId}는 studentId ${dto.studentId}와 연결되지 않았습니다.`);
      }
    }
    return this.store.insert<Payment>(PAYMENTS_SPEC, {
      studentId: dto.studentId,
      enrollmentId: dto.enrollmentId,
      payerParentId: dto.payerParentId,
      amount: dto.amount,
      paidAmount: 0,
      status: 'pending',
      paymentMethod: dto.paymentMethod,
      dueAt: dto.dueAt,
    });
  }

  // 청구 정정. 수납 완료/환불 건은 원장 보존을 위해 메모만 정정한다.
  async update(id: number, dto: UpdatePaymentDto): Promise<Payment> {
    const row = this.findOne(id);
    if (row.status !== 'pending' && row.status !== 'overdue'
      && (dto.amount !== undefined || dto.paymentMethod !== undefined || dto.dueAt !== undefined)) {
      throw new BadRequestException(`정정 불가 상태(${row.status}) — 완료된 수납의 금액·수단·기한은 원장 취소/재처리로 변경해야 합니다.`);
    }
    return await this.store.update<Payment>(PAYMENTS_SPEC, id, { ...dto }) as Payment;
  }

  async markPaid(id: number): Promise<Payment> {
    // [원자성] 수납 상태 갱신 + 통합 원장 입금 1줄이 함께(원장 누락 방지)
    return this.unitOfWork.run(async () => {
      const row = this.findOne(id);
      // [H1] 멱등 가드 — 이중 클릭/재시도로 원장 입금이 중복 기록되는 것 방지(코드리뷰 2026-07-02)
      if (row.status === 'paid') throw new BadRequestException('이미 수납 완료된 청구입니다.');
      if (row.status !== 'pending' && row.status !== 'overdue') {
        throw new BadRequestException(`수납 불가 상태(${row.status}) — pending/overdue만 수납 가능`);
      }
      const now = new Date().toISOString();
      const updated = await this.store.updateIf<Payment>(PAYMENTS_SPEC, id, { status: row.status }, {
        status: 'paid',
        paidAmount: row.amount,
        paidAt: now,
      });
      if (!updated) throw new ConflictException('청구 상태가 이미 변경되었습니다. 새로고침 후 다시 시도해 주세요.');
      // [자산화 점검 2026-07-02] 수납 = 통합 원장(transactions)에 입금 1줄 — payouts.pay와 동일 패턴.
      //  이전엔 결제 상태만 바뀌고 원장 미기록 → 매출 집계(자산)에서 수납이 누락되던 갭.
      await this.store.insert<Transaction>(TRANSACTIONS_SPEC, {
        direction: 'in',
        category: 'enrollment',
        label: `수강료 수납 — 학생 ${row.studentId}${row.enrollmentId != null ? ` · 수강 ${row.enrollmentId}` : ''}`,
        amount: row.amount,
        occurredAt: now,
        paymentId: id,
      });
      return updated;
    });
  }

  // [원장 완결성 2026-07-03] 환불 — 수납의 역방향 출금을 원장에 기록(실DB 가정 감사에서 발견된 공백).
  //  paid 상태에서만 가능(멱등 — 재클릭/미수납 환불 400), 전액 환불(부분 환불은 partial_refund 확장 여지).
  async refund(id: number): Promise<Payment> {
    return this.unitOfWork.run(async () => {
      const row = this.findOne(id);
      if (row.status !== 'paid') throw new BadRequestException('수납 완료(paid) 상태에서만 환불할 수 있습니다.');
      const now = new Date().toISOString();
      const updated = await this.store.updateIf<Payment>(PAYMENTS_SPEC, id, { status: 'paid' }, { status: 'refunded' });
      if (!updated) throw new ConflictException('청구 상태가 이미 변경되었습니다. 새로고침 후 다시 시도해 주세요.');
      await this.store.insert<Transaction>(TRANSACTIONS_SPEC, {
        direction: 'out',
        category: 'refund',
        label: `수강료 환불 — 학생 ${row.studentId}${row.enrollmentId != null ? ` · 수강 ${row.enrollmentId}` : ''}`,
        amount: row.paidAmount ?? row.amount,
        occurredAt: now,
        paymentId: id, // 역참조: 어느 수납의 환불인지(원장 조인 키)
      });
      return updated;
    });
  }
}
