import { Body, Controller, Get, Param, ParseIntPipe, Post, Query, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import type { JwtClaims } from '../auth/auth.service';
import { ApiTags, ApiOperation, ApiQuery, ApiBearerAuth, ApiParam, ApiOkResponse, ApiCreatedResponse, ApiBadRequestResponse, ApiUnauthorizedResponse, ApiForbiddenResponse } from '@nestjs/swagger';
import { PayoutsService } from './payouts.service';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { GeneratePayoutDto, AdjustPayoutDto, RejectPayoutDto } from './dto/payout.dto';

@ApiTags('payouts')
@ApiBearerAuth()
@UseGuards(RolesGuard)
@Controller('payouts')
export class PayoutsController {
  constructor(private readonly payouts: PayoutsService) {}

  @Get()
  @Roles('super_admin') // [TBO-21 RBAC] 전체 정산 목록은 돈 관련 정보 → 대표 전용
  @ApiOperation({ summary: '정산서 목록 [대표]' })
  findAll() {
    return this.payouts.findAll();
  }

  // GET /api/payouts/preview?instructorId=&from=&to= — 산정 미리보기(읽기 전용)
  @Get('preview')
  @Roles('super_admin')
  @ApiOperation({ summary: '시수×시급 산정 미리보기(정산서 생성 없음). 적격: held + 승인 보고서. [대표]' })
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

  @Get('me')
  @Roles('instructor')
  @ApiOperation({ summary: '내 정산서 목록 [강사 본인]' })
  findMine(@Req() req: Request & { user?: JwtClaims }) {
    return this.payouts.findByInstructor(req.user!.sub);
  }

  @Get('me/preview')
  @Roles('instructor')
  @ApiOperation({ summary: '내 시수×시급 산정 미리보기 [강사 본인]' })
  @ApiQuery({ name: 'from', required: true })
  @ApiQuery({ name: 'to', required: true })
  previewMine(
    @Req() req: Request & { user?: JwtClaims },
    @Query('from') from: string,
    @Query('to') to: string,
  ) {
    return this.payouts.preview(req.user!.sub, from, to);
  }

  @Get(':id')
  @Roles('super_admin')
  findOne(@Param('id', ParseIntPipe) id: number) {
    return this.payouts.findOne(id);
  }

  // POST /api/payouts/generate — 정산서 생성 + 세션 연결(이중 계상 방지)
  @Post('generate')
  @Roles('super_admin')
  @ApiOperation({ summary: '정산서 생성(pending) — 적격 세션 묶음·시급 조인 산정·세션 연결. [대표]' })
  @ApiCreatedResponse({ description: '생성된 정산서(InstructorPayout): status=pending, amount, sessionCount, totalMinutes, lines[]' })
  @ApiBadRequestResponse({ description: '적격 세션 0(이미 연결/기간 오류)' })
  @ApiUnauthorizedResponse({ description: '토큰 없음' })
  @ApiForbiddenResponse({ description: '권한 없음(대표 전용)' })
  generate(@Body() body: GeneratePayoutDto, @Req() req: Request & { user?: JwtClaims }) {
    return this.payouts.generate(body.instructorId, body.from, body.to, req.user?.sub);
  }

  // 대표 액션 — TBO-21: 강사 페이 확정/조정/반려/지급은 super_admin 전용.
  @Post(':id/confirm')
  @Roles('super_admin')
  @ApiParam({ name: 'id', description: '정산서 id' })
  @ApiOperation({ summary: '대표 확정(pending → confirmed) [대표]' })
  @ApiCreatedResponse({ description: '정산서(status=confirmed)' })
  confirm(@Param('id', ParseIntPipe) id: number, @Req() req: Request & { user?: JwtClaims }) {
    return this.payouts.confirm(id, req.user?.sub);
  }

  @Post(':id/adjust')
  @Roles('super_admin')
  @ApiParam({ name: 'id', description: '정산서 id' })
  @ApiOperation({ summary: '대표 급여 수정(실효 지급액 덮어쓰기, 자동 산정액 보존) [대표]' })
  @ApiCreatedResponse({ description: '정산서(computedAmount 보존, adjustedAmount·amount 갱신)' })
  adjust(@Param('id', ParseIntPipe) id: number, @Body() body: AdjustPayoutDto, @Req() req: Request & { user?: JwtClaims }) {
    return this.payouts.adjust(id, body.amount, body.reason, req.user?.sub);
  }

  @Post(':id/reject')
  @Roles('super_admin')
  @ApiParam({ name: 'id', description: '정산서 id' })
  @ApiOperation({ summary: '대표 반려(→ rejected) + 연결 세션 회수(재산정 가능) [대표]' })
  @ApiCreatedResponse({ description: '정산서(status=rejected, rejectedReason)' })
  reject(@Param('id', ParseIntPipe) id: number, @Req() req: Request & { user?: JwtClaims }, @Body() body?: RejectPayoutDto) {
    return this.payouts.reject(id, body?.reason, req.user?.sub);
  }

  @Post(':id/pay')
  @Roles('super_admin')
  @ApiParam({ name: 'id', description: '정산서 id' })
  @ApiOperation({ summary: '지급 완료(confirmed → paid) + 통합 원장 출금 기록 [대표]' })
  @ApiCreatedResponse({ description: '{ payout: status=paid, transaction: 원장 출금 1건 }' })
  @ApiBadRequestResponse({ description: 'confirmed 상태가 아님' })
  pay(@Param('id', ParseIntPipe) id: number, @Req() req: Request & { user?: JwtClaims }) {
    return this.payouts.pay(id, req.user?.sub);
  }
}
