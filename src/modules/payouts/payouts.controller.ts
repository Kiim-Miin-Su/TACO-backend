import { Body, Controller, Get, Param, ParseIntPipe, Post, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiQuery, ApiBearerAuth, ApiParam, ApiOkResponse, ApiCreatedResponse, ApiBadRequestResponse, ApiUnauthorizedResponse, ApiForbiddenResponse } from '@nestjs/swagger';
import { PayoutsService } from './payouts.service';
import { RolesGuard } from '../auth/roles.guard';
import { Roles, ADMIN_ROLES } from '../auth/roles.decorator';
import { GeneratePayoutDto, AdjustPayoutDto, RejectPayoutDto } from './dto/payout.dto';

@ApiTags('payouts')
@ApiBearerAuth()
@UseGuards(RolesGuard)
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
  @Roles(...ADMIN_ROLES)
  @ApiOperation({ summary: '정산서 생성(pending) — 적격 세션 묶음·시급 조인 산정·세션 연결. [관리자]' })
  @ApiCreatedResponse({ description: '생성된 정산서(InstructorPayout): status=pending, amount, sessionCount, totalMinutes, lines[]' })
  @ApiBadRequestResponse({ description: '적격 세션 0(이미 연결/기간 오류)' })
  @ApiUnauthorizedResponse({ description: '토큰 없음' })
  @ApiForbiddenResponse({ description: '권한 없음(관리자 전용)' })
  generate(@Body() body: GeneratePayoutDto) {
    return this.payouts.generate(body.instructorId, body.from, body.to);
  }

  // 관리자 액션 — RolesGuard로 super_admin/manager/admin만 허용.
  @Post(':id/confirm')
  @Roles(...ADMIN_ROLES)
  @ApiParam({ name: 'id', description: '정산서 id' })
  @ApiOperation({ summary: '관리자 확정(pending → confirmed) [관리자]' })
  @ApiCreatedResponse({ description: '정산서(status=confirmed)' })
  confirm(@Param('id', ParseIntPipe) id: number) {
    return this.payouts.confirm(id);
  }

  @Post(':id/adjust')
  @Roles(...ADMIN_ROLES)
  @ApiParam({ name: 'id', description: '정산서 id' })
  @ApiOperation({ summary: '관리자 급여 수정(실효 지급액 덮어쓰기, 자동 산정액 보존) [관리자]' })
  @ApiCreatedResponse({ description: '정산서(computedAmount 보존, adjustedAmount·amount 갱신)' })
  adjust(@Param('id', ParseIntPipe) id: number, @Body() body: AdjustPayoutDto) {
    return this.payouts.adjust(id, body.amount, body.reason);
  }

  @Post(':id/reject')
  @Roles(...ADMIN_ROLES)
  @ApiParam({ name: 'id', description: '정산서 id' })
  @ApiOperation({ summary: '관리자 반려(→ rejected) + 연결 세션 회수(재산정 가능) [관리자]' })
  @ApiCreatedResponse({ description: '정산서(status=rejected, rejectedReason)' })
  reject(@Param('id', ParseIntPipe) id: number, @Body() body?: RejectPayoutDto) {
    return this.payouts.reject(id, body?.reason);
  }

  @Post(':id/pay')
  @Roles(...ADMIN_ROLES)
  @ApiParam({ name: 'id', description: '정산서 id' })
  @ApiOperation({ summary: '지급 완료(confirmed → paid) + 통합 원장 출금 기록 [관리자]' })
  @ApiCreatedResponse({ description: '{ payout: status=paid, transaction: 원장 출금 1건 }' })
  @ApiBadRequestResponse({ description: 'confirmed 상태가 아님' })
  pay(@Param('id', ParseIntPipe) id: number) {
    return this.payouts.pay(id);
  }
}
