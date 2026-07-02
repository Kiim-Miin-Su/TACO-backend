import { Injectable, NotFoundException } from '@nestjs/common';
import { InMemoryDatabase } from '../../database/in-memory.database';
import { Expense, EXPENSES } from './expense.entity';
import { CreateExpenseDto } from './dto/create-expense.dto';

@Injectable()
export class ExpensesService {
  constructor(private readonly db: InMemoryDatabase) {}

  findAll(): Expense[] {
    return this.db.findAll<Expense>(EXPENSES);
  }

  findOne(id: number): Expense {
    const row = this.db.findById<Expense>(EXPENSES, id);
    if (!row) throw new NotFoundException(`Expense ${id} not found`);
    return row;
  }

  // 지출은 요청(requested)으로 생성 → super_admin 승인 필요
  create(dto: CreateExpenseDto): Expense {
    return this.db.insert<Expense>(EXPENSES, {
      category: dto.category,
      title: dto.title,
      amount: dto.amount,
      spentAt: dto.spentAt,
      vendor: dto.vendor,
      memo: dto.memo,
      receiptUrl: dto.receiptUrl,
      status: 'requested',
    });
  }

  approve(id: number): Expense {
    this.findOne(id);
    return this.db.update<Expense>(EXPENSES, id, { status: 'approved' }) as Expense;
  }

  reject(id: number): Expense {
    this.findOne(id);
    return this.db.update<Expense>(EXPENSES, id, { status: 'rejected' }) as Expense;
  }
}
