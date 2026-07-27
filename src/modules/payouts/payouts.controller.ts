import { Body, Controller, Get, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import {
  OptionalBoundedIntPipe,
  OptionalPositiveIntPipe,
  PositiveIntPipe,
} from '../../common/positive-int.pipe';
import type { Request } from 'express';
import type { JwtClaims } from '../auth/auth.service';
import { ApiTags, ApiOperation, ApiQuery, ApiBearerAuth, ApiParam, ApiCreatedResponse, ApiBadRequestResponse, ApiUnauthorizedResponse, ApiForbiddenResponse } from '@nestjs/swagger';
import { PayoutsService } from './payouts.service';
import { PayoutsReadService } from './payouts-read.service'; // [TBO-69 C2]
import { RolesGuard } from '../auth/roles.guard';
import { ADMIN_ROLES, Roles } from '../auth/roles.decorator';
import { SudoGuard } from '../auth/sudo.guard'; // [TBO-59 C3-2]
import { GeneratePayoutDto, GenerateBulkPayoutDto, AdjustPayoutDto, RejectPayoutDto, ReversePayoutDto, UnconfirmPayoutDto } from './dto/payout.dto';
import { PayoutReadinessService } from './payout-readiness.service';

const OPTIONAL_PAYOUT_MONTHS = new OptionalBoundedIntPipe(1, 12, 'months');

@ApiTags('payouts')
@ApiBearerAuth()
@UseGuards(RolesGuard)
@Controller('payouts')
export class PayoutsController {
  constructor(
    private readonly payouts: PayoutsService, // 명령(생성·확정·지급·회수)
    private readonly payoutsRead: PayoutsReadService, // [TBO-69 C2] 읽기(산정·워크시트·목록·미정산)
    private readonly readiness: PayoutReadinessService,
  ) {}

  @Get()
  @Roles('super_admin') // [TBO-21 RBAC] 전체 정산 목록은 돈 관련 정보 → 대표 전용
  @ApiOperation({ summary: '정산서 목록 [대표]' })
  findAll() {
    return this.payoutsRead.listDb(); // [TBO-56 C2b] DB 권위 READ
  }

  // GET /api/payouts/preview?instructorId=&from=&to= — 산정 미리보기(읽기 전용)
  @Get('preview')
  @Roles('super_admin')
  @ApiOperation({ summary: '시수×시급 산정 미리보기(정산서 생성 없음). 적격: held + roster 전원 보고서 승인. [대표]' })
  @ApiQuery({ name: 'instructorId', required: true })
  @ApiQuery({ name: 'from', required: true })
  @ApiQuery({ name: 'to', required: true })
  preview(
    @Query('instructorId', PositiveIntPipe) instructorId: number,
    @Query('from') from: string,
    @Query('to') to: string,
  ) {
    return this.payoutsRead.measureFresh(instructorId, from, to); // [TBO-56 C2b] 입력 표 재수화 후 산정
  }

  @Get('me')
  @Roles('instructor')
  @ApiOperation({ summary: '내 지급 완료 정산 내역 [강사 본인] — paid만. 시수 산정·지급 전 정산은 관리자 전용(TBO-62 ⑥).' })
  findMine(@Req() req: Request & { user?: JwtClaims }) {
    // [TBO-62 ⑥ 2026-07-24] 대표 지시: 강사는 "지금까지 받은 것"만 — 시수 측정·예상 페이·지급 전
    //  상태(pending/confirmed)는 비노출(paid만). preview/readiness 강사 라우트는 제거됨.
    return this.payoutsRead.listByInstructorDb(req.user!.sub, { paidOnly: true });
  }

  @Get('readiness')
  @Roles(...ADMIN_ROLES)
  @ApiOperation({ summary: '전체 또는 지정 강사의 시수·페이 누락 항목(학생별 보고서 포함) [매니저 이상]' })
  @ApiQuery({ name: 'instructorId', required: false })
  @ApiQuery({ name: 'from', required: false, description: '기본: 종료일 기준 90일 전' })
  @ApiQuery({ name: 'to', required: false, description: '기본: 오늘(KST)' })
  readinessAll(
    @Query('instructorId', OptionalPositiveIntPipe) instructorId?: number,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.readiness.evaluateFresh(instructorId, from, to); // [TBO-56 C2b] 입력 표 재수화 후 판정
  }

  // [TBO-32 C1 2026-07-20] 미정산 감지 — 최근 N개월 중 적격 세션이 남아 있는 (강사×월) 목록.
  //  ⚠ 라우트 순서: ':id' 앞에 두어야 'uncovered'가 숫자 파싱에 잡히지 않는다.
  @Get('uncovered')
  @Roles('super_admin')
  @ApiOperation({ summary: '미정산 감지 — 적격 세션이 정산서에 미연결인 (강사×월) 목록(당월 포함 N개월). [대표]' })
  @ApiQuery({ name: 'months', required: false, description: '조회 개월 수(1~12, 기본 3)' })
  uncovered(
    @Query('months', OPTIONAL_PAYOUT_MONTHS) months?: number,
  ) {
    return this.payoutsRead.uncoveredFresh(months); // [TBO-56 C2b]
  }

  // [TBO-64 2026-07-24] 시수 워크시트 — 강사·기간의 전 회차(출결·리포트·가격 분류·합계).
  //  ⚠ 라우트 순서: ':id' 앞. 산정 정책은 preview/generate와 동일 분류 함수(단일 진실원).
  @Get('worksheet')
  @Roles(...ADMIN_ROLES)
  @ApiOperation({ summary: '시수 워크시트 — 회차별 출결·리포트·가격 분류(자동/책정 필요/제외)·기간 합계 [매니저 이상]' })
  @ApiQuery({ name: 'instructorId', required: true })
  @ApiQuery({ name: 'from', required: true })
  @ApiQuery({ name: 'to', required: true })
  worksheet(
    @Query('instructorId', PositiveIntPipe) instructorId: number,
    @Query('from') from: string,
    @Query('to') to: string,
  ) {
    return this.payoutsRead.worksheetFresh(instructorId, from, to);
  }

  @Get(':id')
  @Roles('super_admin')
  @ApiOperation({ summary: '정산서 단건과 산정 line 조회 [대표]. 강사용 지급 요약 호환 API는 GET /payouts/me이며 UI에서는 호출하지 않음.' })
  findOne(@Param('id', PositiveIntPipe) id: number, @Req() req: Request) {
    const actor = (req as Request & { user?: JwtClaims }).user;
    return this.payoutsRead.getScopedDb(id, actor?.roles ?? [], actor?.sub); // [TBO-56 C2b] DB 권위 READ
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

  // [TBO-32 C1 2026-07-20] 일괄 산정 — 강사별 독립 tx(부분 실패 요약: generated/skipped/failed).
  @Post('generate-bulk')
  @Roles('super_admin')
  @ApiOperation({ summary: '일괄 정산 산정 — 기간 내 전(또는 지정) 강사, 강사별 독립 tx·부분 실패 요약. [대표]' })
  generateBulk(@Body() dto: GenerateBulkPayoutDto, @Req() req: Request) {
    const actor = (req as Request & { user?: JwtClaims }).user;
    return this.payouts.generateBulk(dto.periodStart, dto.periodEnd, dto.instructorIds, actor?.sub);
  }

  // 대표 액션 — TBO-21: 강사 페이 확정/조정/반려/지급은 super_admin 전용.
  @Post(':id/confirm')
  @Roles('super_admin')
  @ApiParam({ name: 'id', description: '정산서 id' })
  @ApiOperation({ summary: '대표 확정(pending → confirmed) [대표]' })
  @ApiCreatedResponse({ description: '정산서(status=confirmed)' })
  confirm(@Param('id', PositiveIntPipe) id: number, @Req() req: Request & { user?: JwtClaims }) {
    return this.payouts.confirm(id, req.user?.sub);
  }

  // [TBO-32 C2 2026-07-22] 확정 취소 — 지급 전 확정 실수의 출구(상태 그래프 완결: pending⇄confirmed).
  @Post(':id/unconfirm')
  @Roles('super_admin')
  @ApiOperation({ summary: '정산 확정 취소(confirmed→pending, 사유 필수·감사 이력) [대표]. 지급 후에는 회수(reverse).' })
  unconfirm(@Param('id', PositiveIntPipe) id: number, @Body() dto: UnconfirmPayoutDto, @Req() req: Request) {
    const actor = (req as Request & { user?: JwtClaims }).user;
    return this.payouts.unconfirm(id, dto.reason, actor?.sub);
  }

  @Post(':id/adjust')
  @UseGuards(SudoGuard)
  @Roles('super_admin')
  @ApiParam({ name: 'id', description: '정산서 id' })
  @ApiOperation({ summary: '대표 급여 수정(실효 지급액 덮어쓰기, 자동 산정액 보존, 사유·재인증 필수) [대표]' })
  @ApiCreatedResponse({ description: '정산서(computedAmount 보존, adjustedAmount·amount 갱신)' })
  adjust(@Param('id', PositiveIntPipe) id: number, @Body() body: AdjustPayoutDto, @Req() req: Request & { user?: JwtClaims }) {
    return this.payouts.adjust(id, body.amount, body.reason, req.user?.sub);
  }

  @Post(':id/reject')
  @Roles('super_admin')
  @ApiParam({ name: 'id', description: '정산서 id' })
  @ApiOperation({ summary: '대표 반려(→ rejected) + 연결 세션 회수(재산정 가능) [대표]' })
  @ApiCreatedResponse({ description: '정산서(status=rejected, rejectedReason)' })
  reject(@Param('id', PositiveIntPipe) id: number, @Req() req: Request & { user?: JwtClaims }, @Body() body?: RejectPayoutDto) {
    return this.payouts.reject(id, body?.reason, req.user?.sub);
  }

  // [B9 E5 2026-07-16] 지급 회수(보상 command) — paid 정산의 유일한 되돌림 경로.
  @Post(':id/reverse')
  @UseGuards(SudoGuard)
  @Roles('super_admin')
  @ApiParam({ name: 'id', description: '정산서 id' })
  @ApiOperation({ summary: '지급 회수(paid → rejected+reversedAt) — 보상 원장 입금 1건 + 연결 세션 전량 회수(재산정 가능, 재인증 필수) [대표]' })
  @ApiCreatedResponse({ description: '{ payout: rejected+reversedAt, transaction: 원장 입금(payout_reversal) 1건 }' })
  @ApiBadRequestResponse({ description: 'paid 상태가 아님(지급 전 취소는 반려 사용) 또는 사유 누락' })
  reverse(@Param('id', PositiveIntPipe) id: number, @Body() body: ReversePayoutDto, @Req() req: Request & { user?: JwtClaims }) {
    return this.payouts.reverse(id, body.reason, req.user?.sub);
  }

  @Post(':id/pay')
  @UseGuards(SudoGuard) // [TBO-59 C3-2] 지급 확정(원장 출금) = sudo 재인증
  @Roles('super_admin')
  @ApiParam({ name: 'id', description: '정산서 id' })
  @ApiOperation({ summary: '지급 완료(confirmed → paid) + 통합 원장 출금 기록(재인증 필수) [대표]. cookie 세션은 reauth 후 10분 내만 허용(403 SUDO_REQUIRED).' })
  @ApiCreatedResponse({ description: '{ payout: status=paid, transaction: 원장 출금 1건 }' })
  @ApiBadRequestResponse({ description: 'confirmed 상태가 아님' })
  pay(@Param('id', PositiveIntPipe) id: number, @Req() req: Request & { user?: JwtClaims }) {
    return this.payouts.pay(id, req.user?.sub);
  }
}
