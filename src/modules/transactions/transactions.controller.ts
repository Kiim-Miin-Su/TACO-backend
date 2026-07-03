import { Controller, Get, UseGuards } from '@nestjs/common';
import { RolesGuard } from '../auth/roles.guard';
import { Roles, STAFF_ROLES } from '../auth/roles.decorator';
import { ApiTags, ApiOperation, ApiOkResponse } from '@nestjs/swagger';
import { TransactionsService } from './transactions.service';

@ApiTags('transactions')
@UseGuards(RolesGuard)
@Controller('transactions')
export class TransactionsController {
  constructor(private readonly transactions: TransactionsService) {}

  @Get()
  @Roles(...STAFF_ROLES) // [통신 감사 2026-07-03 H1] 재무 정보 비로그인 노출 차단
  @ApiOperation({ summary: '입·출금 통합 원장(Transaction[]) — 대시보드 매출/지출 집계용' })
  @ApiOkResponse({ description: 'Transaction[] — direction(in/out)·category·label·amount·method·occurredAt' })
  findAll() {
    return this.transactions.findAll();
  }
}
