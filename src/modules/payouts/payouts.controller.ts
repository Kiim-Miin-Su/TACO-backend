import { Body, Controller, Get, Param, ParseIntPipe, Post, Query } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiQuery } from '@nestjs/swagger';
import { PayoutsService } from './payouts.service';

@ApiTags('payouts')
@Controller('payouts')
export class PayoutsController {
  constructor(private readonly payouts: PayoutsService) {}

  @Get()
  @ApiOperation({ summary: '정산서 목록' })
  findAll() {
    return this.payouts.findAll();
  }

  // GET /api/payouts/preview?instructorId=&from=&to= — 산정 미리보기(읽기 전용)
  @Get('preview')
  @ApiOperation({ summary: '시수×시급 산정 미리보기(정산서 생성 없음). 적격: held + 승인 보고서.' })
  @ApiQuery({ name: 'instructorId', required: true })
  @ApiQuery({ name: 'from', required: true })
  @ApiQuery({ name: 'to', required: true })
  preview(
    @Query('instructorId', ParseIntPipe) instructorId: number,
    @Query('from') from: string,
    @Query('to') to: string,
  ) {
    return this.payouts.preview(instructorId, from, to);
  }

  @Get(':id')
  findOne(@Param('id', ParseIntPipe) id: number) {
    return this.payouts.findOne(id);
  }

  // POST /api/payouts/generate — 정산서 생성 + 세션 연결(이중 계상 방지)
  @Post('generate')
  @ApiOperation({ summary: '정산서 생성(pending) — 적격 세션 묶음·시급 조인 산정·세션 연결.' })
  generate(@Body() body: { instructorId: number; from: string; to: string }) {
    return this.payouts.generate(body.instructorId, body.from, body.to);
  }

  // 관리자 액션 (Guard는 추후 — expenses/approvals 패턴과 동일)
  @Post(':id/confirm')
  @ApiOperation({ summary: '관리자 확정(pending → confirmed)' })
  confirm(@Param('id', ParseIntPipe) id: number) {
    return this.payouts.confirm(id);
  }

  @Post(':id/adjust')
  @ApiOperation({ summary: '관리자 급여 수정(실효 지급액 덮어쓰기, 자동 산정액 보존)' })
  adjust(@Param('id', ParseIntPipe) id: number, @Body() body: { amount: number; reason?: string }) {
    return this.payouts.adjust(id, body.amount, body.reason);
  }

  @Post(':id/reject')
  @ApiOperation({ summary: '관리자 반려(→ rejected) + 연결 세션 회수(재산정 가능)' })
  reject(@Param('id', ParseIntPipe) id: number, @Body() body?: { reason?: string }) {
    return this.payouts.reject(id, body?.reason);
  }

  @Post(':id/pay')
  @ApiOperation({ summary: '지급 완료(confirmed → paid) + 통합 원장 출금 기록' })
  pay(@Param('id', ParseIntPipe) id: number) {
    return this.payouts.pay(id);
  }
}
