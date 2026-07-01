import { Controller, Get } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiOkResponse } from '@nestjs/swagger';
import { TransactionsService } from './transactions.service';

@ApiTags('transactions')
@Controller('transactions')
export class TransactionsController {
  constructor(private readonly transactions: TransactionsService) {}

  @Get()
  @ApiOperation({ summary: '입·출금 통합 원장(Transaction[]) — 대시보드 매출/지출 집계용' })
  @ApiOkResponse({ description: 'Transaction[] — direction(in/out)·category·label·amount·method·occurredAt' })
  findAll() {
    return this.transactions.findAll();
  }
}
