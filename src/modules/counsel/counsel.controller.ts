import { Body, Controller, Delete, Get, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import { OptionalPositiveIntPipe, PositiveIntPipe } from '../../common/positive-int.pipe';
import { ApiTags, ApiOperation, ApiQuery, ApiOkResponse, ApiCreatedResponse, ApiBearerAuth, ApiForbiddenResponse } from '@nestjs/swagger';
import type { Request } from 'express';
import { CounselService } from './counsel.service';
import { CreateCounselDto } from './dto/create-counsel.dto';
import { UpdateCounselDto } from './dto/update-counsel.dto';
import { CreateCounselRoundDto } from './dto/create-round.dto';
import { UpdateCounselRoundDto } from './dto/update-round.dto';
import { RolesGuard } from '../auth/roles.guard';
import { Roles, ADMIN_ROLES } from '../auth/roles.decorator';
import type { JwtClaims } from '../auth/auth.service';

// [TBO-37] /api/counsel — 상담 목록·회차·현재 예약일은 관리 역할 전용.
//  폼 생성/수정 + 회차 추가. 관심 과목/코스 FK·부모 폼 FK를 서비스가 검증.
@ApiTags('counsel')
@ApiBearerAuth()
@UseGuards(RolesGuard)
@Controller('counsel')
export class CounselController {
  constructor(private readonly counsel: CounselService) {}

  @Get()
  @Roles(...ADMIN_ROLES)
  @ApiOperation({ summary: '상담 접수 목록(CounselForm[])' })
  @ApiForbiddenResponse({ description: '강사 접근 불가 — manager/admin/super_admin 전용' })
  @ApiOkResponse({ description: 'CounselForm[] — 신청자·상태·관심 과목/코스·다음 상담일 등' })
  findForms() {
    return this.counsel.findAllForms();
  }

  @Get('rounds')
  @Roles(...ADMIN_ROLES)
  @ApiOperation({ summary: '상담 회차 목록(CounselRound[]). counselFormId로 필터. [관리 역할]' })
  @ApiQuery({ name: 'counselFormId', required: false })
  @ApiOkResponse({ description: 'CounselRound[] — 회차·요약·결과·다음 액션' })
  findRounds(
    @Query('counselFormId', OptionalPositiveIntPipe)
    counselFormId?: number,
  ) {
    return this.counsel.findAllRounds(counselFormId);
  }

  // [TBO-30D 2026-07-23] 퍼널 집계 — 순수 함수(counsel-analytics) 파생, DB 원본 무변형. ':id'보다 앞 선언.
  @Get('analytics/funnel')
  @Roles(...ADMIN_ROLES)
  @ApiOperation({ summary: '상담 퍼널 집계 — 상태·회차 도달·이탈 회차·전환율·평균 소요(순수 함수 파생, 기간 필터) [관리 역할]' })
  @ApiQuery({ name: 'from', required: false, description: '접수일 시작(YYYY-MM-DD)' })
  @ApiQuery({ name: 'to', required: false, description: '접수일 끝(YYYY-MM-DD)' })
  funnel(@Query('from') from?: string, @Query('to') to?: string) {
    return this.counsel.funnel({ from: from || null, to: to || null });
  }

  // [TBO-30E 2026-07-23] 상담↔수강 상관관계 — 희망(student_interests)×등록(enrollments) 과목 조인 매트릭스.
  @Get('analytics/correlation')
  @Roles(...ADMIN_ROLES)
  @ApiOperation({ summary: '상담↔수강 과목 상관관계 — 희망 과목(관심 SSOT)×실제 등록 과목(enrollments) 조인 매트릭스·전환율 [관리 역할]' })
  @ApiQuery({ name: 'from', required: false, description: '접수일 시작(YYYY-MM-DD)' })
  @ApiQuery({ name: 'to', required: false, description: '접수일 끝(YYYY-MM-DD)' })
  correlation(@Query('from') from?: string, @Query('to') to?: string) {
    return this.counsel.correlation({ from: from || null, to: to || null });
  }

  // [B7 E3 2026-07-16] GET /api/counsel/:id — 상담 폼 단건(상세 화면 전량 로드 후 find 제거).
  //  없는 id=404(서비스 findForm). 정적 GET('rounds')보다 뒤에 선언(':id' 가로채기 방지).
  @Get(':id')
  @Roles(...ADMIN_ROLES)
  @ApiOperation({ summary: '상담 폼 단건(CounselForm) — 관리 역할 상세 화면용. 없는 id=404.' })
  @ApiOkResponse({ description: 'CounselForm' })
  findForm(@Param('id', PositiveIntPipe) id: number) {
    return this.counsel.findForm(id);
  }

  @Get(':id/aggregate')
  @Roles(...ADMIN_ROLES)
  @ApiOperation({ summary: '상담 폼+회차+연결 학생 aggregate [관리 역할]' })
  findAggregate(@Param('id', PositiveIntPipe) id: number) {
    return this.counsel.findAggregate(id);
  }

  @Post()
  @Roles(...ADMIN_ROLES)
  @ApiOperation({ summary: '상담 접수 생성 [관리 역할] — 전체 폼 저장, status=requested, nextContactAt은 예약 캘린더 단일 소스' })
  @ApiCreatedResponse({ description: '생성된 CounselForm' })
  createForm(@Body() dto: CreateCounselDto, @Req() req: Request & { user?: JwtClaims }) {
    return this.counsel.createForm(dto, req.user!.sub);
  }

  @Patch(':id')
  @Roles(...ADMIN_ROLES)
  @ApiOperation({ summary: '상담 폼 수정 [관리 역할] — 전체 입력 및 nextContactAt 예약 캘린더 동기화' })
  @ApiOkResponse({ description: '수정된 CounselForm' })
  updateForm(@Param('id', PositiveIntPipe) id: number, @Body() dto: UpdateCounselDto, @Req() req: Request & { user?: JwtClaims }) {
    return this.counsel.updateForm(id, dto, req.user!.sub);
  }

  @Delete(':id')
  @Roles(...ADMIN_ROLES)
  @ApiOperation({ summary: '상담 폼과 회차 soft delete [관리 역할] — 감사 스냅샷 포함' })
  removeForm(@Param('id', PositiveIntPipe) id: number, @Req() req: Request & { user?: JwtClaims }) {
    return this.counsel.removeForm(id, req.user!.sub);
  }

  @Post(':id/rounds')
  @Roles(...ADMIN_ROLES)
  @ApiOperation({ summary: '상담 회차 추가 [관리 역할] — roundNo 자동, 폼 nextContactAt 동기화' })
  @ApiCreatedResponse({ description: '생성된 CounselRound' })
  createRound(@Param('id', PositiveIntPipe) id: number, @Body() dto: CreateCounselRoundDto, @Req() req: Request & { user?: JwtClaims }) {
    return this.counsel.createRound(id, dto, req.user!.sub);
  }

  @Patch(':id/rounds/:roundId')
  @Roles(...ADMIN_ROLES)
  @ApiOperation({ summary: '상담 회차 수정 [관리 역할] — snapshot/다음 상담일 동기화+감사' })
  updateRound(
    @Param('id', PositiveIntPipe) id: number,
    @Param('roundId', PositiveIntPipe) roundId: number,
    @Body() dto: UpdateCounselRoundDto,
    @Req() req: Request & { user?: JwtClaims },
  ) {
    return this.counsel.updateRound(id, roundId, dto, req.user!.sub);
  }

  @Delete(':id/rounds/:roundId')
  @Roles(...ADMIN_ROLES)
  @ApiOperation({ summary: '상담 회차 soft delete [관리 역할] — 최신 다음 상담일 재계산+감사' })
  removeRound(
    @Param('id', PositiveIntPipe) id: number,
    @Param('roundId', PositiveIntPipe) roundId: number,
    @Req() req: Request & { user?: JwtClaims },
  ) {
    return this.counsel.removeRound(id, roundId, req.user!.sub);
  }
}
