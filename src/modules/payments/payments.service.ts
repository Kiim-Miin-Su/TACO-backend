import { Injectable, NotFoundException } from '@nestjs/common';
import { InMemoryDatabase } from '../../database/in-memory.database';
import { Payment, PAYMENTS } from './payment.entity';
import { CreatePaymentDto } from './dto/create-payment.dto';

@Injectable()
export class PaymentsService {
  constructor(private readonly db: InMemoryDatabase) {}

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
