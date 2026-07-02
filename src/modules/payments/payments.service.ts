import { Injectable, NotFoundException, OnModuleInit } from '@nestjs/common';
import { InMemoryDatabase } from '../../database/in-memory.database';
import { Payment, PAYMENTS } from './payment.entity';
import { CreatePaymentDto } from './dto/create-payment.dto';
import { UpdatePaymentDto } from './dto/update-payment.dto';

@Injectable()
export class PaymentsService implements OnModuleInit {
  constructor(private readonly db: InMemoryDatabase) {}

  // 데모 결제 시드 — 프론트 목데이터 이관. enrollmentId→enrollments, studentId→students(무결성).
  // 미수(pending+dueAt) 2건 → 결제 탭 배지가 백엔드 기준으로 동작.
  onModuleInit(): void {
    if (this.db.findAll<Payment>(PAYMENTS).length) return;
    this.db.seed<Payment>(PAYMENTS, [
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
  create(dto: CreatePaymentDto): Payment {
    return this.db.insert<Payment>(PAYMENTS, {
      studentId: dto.studentId,
      enrollmentId: dto.enrollmentId,
      payerParentId: dto.payerParentId,
      amount: dto.amount,
      paidAmount: 0,
      status: 'pending',
      paymentMethod: dto.paymentMethod,
    });
  }

  // 청구 정정(금액·수단·기한·메모). 수납 완료여도 관리자 정정 허용 — 존재 검증.
  update(id: number, dto: UpdatePaymentDto): Payment {
    this.findOne(id);
    return this.db.update<Payment>(PAYMENTS, id, { ...dto }) as Payment;
  }

  markPaid(id: number): Payment {
    const row = this.findOne(id);
    const updated = this.db.update<Payment>(PAYMENTS, id, {
      status: 'paid',
      paidAmount: row.amount,
      paidAt: new Date().toISOString(),
    });
    return updated as Payment;
  }
}
