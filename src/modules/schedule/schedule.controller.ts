import { BadRequestException, Body, Controller, Delete, ForbiddenException, Get, Param, Patch,
  Put, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import { OptionalPositiveIntPipe, PositiveIntPipe } from '../../common/positive-int.pipe';
import type { Request, Response } from 'express';
import type { JwtClaims } from '../auth/auth.service';
import { ApiTags, ApiOperation, ApiQuery, ApiBearerAuth, ApiParam, ApiCreatedResponse, ApiOkResponse, ApiConflictResponse, ApiUnauthorizedResponse } from '@nestjs/swagger';
import { ScheduleService } from './schedule.service';
import { ScheduleReadService } from './schedule-read.service'; // [TBO-69 C1]
import { SetSessionPayAmountDto, UpdateScheduleDto } from './dto/update-schedule.dto';
import { ClearInstructorAttendanceDto, SetInstructorAttendanceDto } from './dto/instructor-attendance-command.dto';
import { CreateScheduleDto } from './dto/create-schedule.dto';
import { CreateScheduleSeriesDto } from './dto/create-schedule-series.dto';
import { ConflictCheckDto } from './dto/conflict-check.dto';
import { RolesGuard } from '../auth/roles.guard';
import { SudoGuard } from '../auth/sudo.guard';
import {
  RequireCapabilities,
  Roles,
  STAFF_ROLES,
  isInstructorOnly,
} from '../auth/roles.decorator';
import { isSessionVisibleToInstructor } from './schedule-visibility.policy';
import { OpenClassDto, OpenClassSeriesDto } from './dto/open-class.dto';
import { SessionAccountingImpactConflictResponseDto } from './dto/accounting-impact-response.dto';

@ApiTags('scheduling')
@ApiBearerAuth()
@UseGuards(RolesGuard)
@Controller('schedule')
export class ScheduleController {
  constructor(
    private readonly schedule: ScheduleService, // 명령(개설·수정·삭제·복구·책정·출결)
    private readonly scheduleRead: ScheduleReadService, // [TBO-69 C1] 읽기(목록·단건·집계·리소스·충돌 검사)
  ) {}

  // GET /api/schedule?from=YYYY-MM-DD&to=YYYY-MM-DD&instructorId=&roomId=&studentId=
  @Get()
  @Roles(...STAFF_ROLES) // [보안 2026-07-03] 사내 데이터 조회 — 로그인 필수
  @ApiOperation({ summary: '스케줄 조회. 강사는 본인 배정 일반 일정만, 상담 일정은 관리 역할만.' })
  @ApiQuery({ name: 'from', required: false }) @ApiQuery({ name: 'to', required: false })
  @ApiQuery({ name: 'instructorId', required: false }) @ApiQuery({ name: 'roomId', required: false })
  @ApiQuery({ name: 'studentId', required: false, description: '학생 코호트(enrollment status≠drop) 역추적' })
  async list(
    @Req() req: Request & { user?: JwtClaims },
    @Res({ passthrough: true }) res: Response,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('instructorId', OptionalPositiveIntPipe) instructorId?: number,
    @Query('roomId', OptionalPositiveIntPipe) roomId?: number,
    @Query('studentId', OptionalPositiveIntPipe) studentId?: number,
  ) {
    const filters = {
      from,
      to,
      instructorId,
      roomId,
      studentId,
    };
    const rows = await (isInstructorOnly(req.user?.roles)
      ? this.scheduleRead.listVisibleFresh(filters, req.user!.sub)
      : this.scheduleRead.listFresh(filters));
    const read = this.scheduleRead.listReadMetadata();
    res.setHeader('X-Schedule-Read-Source', read.source);
    res.setHeader('X-Schedule-Catalog-Hydrate-Age-Ms', String(read.catalogHydrateAgeMs));
    return rows;
  }

  // GET /api/schedule/resources — 자원 피커(강사·강의실·학생·코스)
  @Get('resources')
  @Roles(...STAFF_ROLES) // [보안 2026-07-03] 사내 데이터 조회 — 로그인 필수
  @ApiOperation({ summary: '자원 피커 — 역할별 강사·강의실·학생·코스+과목 FK+활성 roster. 캘린더 필터·배정 폼 SSOT.' })
  async resources(@Req() req: Request & { user?: JwtClaims }) {
    await this.scheduleRead.ensureReady();
    return this.scheduleRead.resources(isInstructorOnly(req.user?.roles) ? { instructorId: req.user?.sub } : undefined);
  }

  // [TBO-19] GET /api/schedule/instructor-attendance-summary — 강사 출결 현황 집계(관리자 대시보드)
  //  정적 경로라 :id 라우트와 충돌 없음. 관리 지표(민감) → ADMIN_ROLES.
  @Get('instructor-attendance-summary')
  @RequireCapabilities('calendar.manage')
  @ApiOperation({ summary: '강사 출결 현황 집계(기간·강사 필터) — 출/지/결/보강 카운트·출석률·인정 시수·총계' })
  @ApiQuery({ name: 'from', required: false }) @ApiQuery({ name: 'to', required: false })
  @ApiQuery({ name: 'instructorId', required: false })
  async instructorAttendanceSummary(
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('instructorId', OptionalPositiveIntPipe) instructorId?: number,
  ) {
    await this.scheduleRead.ensureReady();
    return this.scheduleRead.instructorAttendanceSummary({
      from, to, instructorId,
    });
  }

  // [B7 E3 2026-07-16] GET /api/schedule/:id — 상세 화면 단건 조회(전량 로드 후 find 제거, EP11).
  //  스코프 표준(B7 문서 §1b): 없는 id=404 → 존재하나 강사 본인 세션 아님=403.
  //  ⚠ 라우트 선언 순서: 정적 GET('resources'·'instructor-attendance-summary')보다 뒤에 두어야 ':id'가 가로채지 않음.
  @Get(':id')
  @Roles(...STAFF_ROLES)
  @ApiParam({ name: 'id', description: '세션 id' })
  @ApiOperation({ summary: '세션 단건. 강사는 본인 배정 일반 일정만, 상담은 관리 역할만(404→403).' })
  @ApiOkResponse({ description: 'ScheduleRow — 강사·과목·강의실명·코호트 포함' })
  async findOne(@Param('id', PositiveIntPipe) id: number, @Req() req: Request & { user?: JwtClaims }) {
    await this.scheduleRead.ensureReady();
    const row = this.scheduleRead.findOneEnriched(id);
    if (isInstructorOnly(req.user?.roles) && !isSessionVisibleToInstructor(row, req.user!.sub))
      throw new ForbiddenException('강사는 본인이 배정된 일반 일정만 조회할 수 있습니다.');
    return row;
  }

  // 충돌 드라이런(생성·이동 전 검사)
  @Post('conflicts')
  @Roles(...STAFF_ROLES) // [코드리뷰 2026-07-03 H1] @Roles 누락 → 무인증 접근 가능했음. 강사·강의실 가용성 탐지 차단
  @ApiOperation({ summary: '충돌 드라이런 — 강사는 JWT 본인 수업 범위, 생성·이동 전 이중예약/불가시간 겹침 검사' })
  @ApiOkResponse({ description: 'Conflict[] — 각 항목 { type, resource, resourceId, sessionId?, detail? }' })
  async conflicts(@Body() body: ConflictCheckDto, @Req() req: Request & { user?: JwtClaims }) {
    await this.scheduleRead.ensureReady();
    if (!isInstructorOnly(req.user?.roles)) return this.scheduleRead.checkConflicts(body);

    const instructorId = req.user!.sub;
    const allowedStudents = new Set(this.scheduleRead.resources({ instructorId }).students.map((student) => Number(student.id)));
    if (body.studentIds?.some((studentId) => !allowedStudents.has(Number(studentId)))) {
      throw new ForbiddenException('강사는 본인 수업 학생의 충돌만 조회할 수 있습니다.');
    }
    if (body.ignoreSessionId != null) {
      const ownsIgnoredSession = this.scheduleRead.list({ instructorId }).some((row) => Number(row.id) === Number(body.ignoreSessionId));
      if (!ownsIgnoredSession) throw new ForbiddenException('타 강사 수업은 충돌 검사에서 제외할 수 없습니다.');
    }
    return this.scheduleRead.checkConflicts({ ...body, instructorId });
  }

  @Post('open-class')
  @RequireCapabilities('calendar.manage')
  @ApiOperation({ summary: '과목명 직접 입력 수업 개설 — 과목/강사별 운영단위/수강/세션/audit 원자 커밋 [매니저 이상]' })
  @ApiCreatedResponse({ description: 'subject + course + enrollments + row + conflicts' })
  openClass(@Body() dto: OpenClassDto, @Req() req: Request & { user?: JwtClaims }) {
    return this.schedule.openClass(dto, req.user?.sub);
  }

  @Post('open-class-series')
  @RequireCapabilities('calendar.manage')
  @ApiOperation({ summary: '과목명 직접 입력 반복 수업 개설 — 과목/수강/시리즈 전체 원자 커밋 [매니저 이상]' })
  @ApiCreatedResponse({ description: 'subject + course + enrollments + series + rows + conflicts' })
  openClassSeries(@Body() dto: OpenClassSeriesDto, @Req() req: Request & { user?: JwtClaims }) {
    return this.schedule.openClassSeries(dto, req.user?.sub);
  }

  // POST /api/schedule — 세션 생성(추천→배정·수동 추가). 충돌 시 409(force=true면 적용).
  @Post()
  @RequireCapabilities('calendar.manage') // 강사는 schedule-requests 승인 흐름으로
  @ApiOperation({ summary: '세션 생성(추천→배정·수동). FK 검증 + 충돌 검사(409 / force=true 강제). [로그인]' })
  @ApiCreatedResponse({ description: '{ row: ScheduleRow(enriched: 강사·과목·강의실명 포함), conflicts: Conflict[] }' })
  @ApiConflictResponse({ description: '{ message, conflicts: Conflict[] } — force=false에서 충돌 시' })
  @ApiUnauthorizedResponse({ description: '토큰 없음(로그인 필요)' })
  create(@Body() dto: CreateScheduleDto, @Req() req: Request & { user?: JwtClaims }) {
    return this.schedule.create(dto, req.user?.sub); // actor → audit_log(create)
  }

  // [TBO-29C C2] POST /api/schedule/series — 반복 생성 bulk command. 서버가 series ID 발급,
  //  전체 conflict 선계산 후 series+occurrence+audit를 한 transaction으로 저장(중간 실패=전부 롤백).
  @Post('series')
  @RequireCapabilities('calendar.manage') // 강사 반복 요청은 schedule-requests 승인 흐름
  @ApiOperation({ summary: '반복 세션 bulk 생성 — 서버 발급 series ID + 규칙 자산화 + 원자 커밋. [로그인]' })
  @ApiCreatedResponse({ description: '{ series: ScheduleSeries, rows: ScheduleRow[], conflicts: Conflict[] }' })
  @ApiConflictResponse({ description: '{ message, conflicts: Conflict[] } — force=false에서 전체 충돌 목록' })
  @ApiUnauthorizedResponse({ description: '토큰 없음(로그인 필요)' })
  createSeries(@Body() dto: CreateScheduleSeriesDto, @Req() req: Request & { user?: JwtClaims }) {
    return this.schedule.createSeries(dto, req.user?.sub);
  }

  // 이동·리사이즈·상세편집. 충돌 시 409 {message, conflicts} (force=true면 적용).
  @Patch(':id')
  @RequireCapabilities('calendar.manage')
  @ApiParam({ name: 'id', description: '세션 id' })
  @ApiOperation({ summary: '세션 이동·리사이즈·상세편집(반복 scope 지원). 충돌 시 409. [로그인]' })
  @ApiOkResponse({ description: '{ row: ScheduleRow, conflicts: Conflict[], updated: number(시리즈 동반 수) }' })
  @ApiConflictResponse({
    type: SessionAccountingImpactConflictResponseDto,
    description: '시간·자원 충돌 또는 시수·정산 영향 확인/지급 회수 필요.',
  })
  update(@Param('id', PositiveIntPipe) id: number, @Body() dto: UpdateScheduleDto, @Req() req: Request & { user?: JwtClaims }) {
    return this.schedule.update(id, dto, req.user?.sub, {
      actorCapabilities: req.user?.effectiveCapabilities ?? [],
    }); // actor → audit_log(update diff)
  }

  @Put(':id/instructor-attendance')
  @RequireCapabilities('attendance.manage')
  @ApiParam({ name: 'id', description: '세션 id' })
  @ApiOperation({ summary: '강사 출결 기록·수정 — 회계 영향 ACK 포함, 대표 권한.' })
  @ApiOkResponse({ description: '{ row, accountingImpact?, accountingImpactHash? }' })
  @ApiConflictResponse({ type: SessionAccountingImpactConflictResponseDto })
  setInstructorAttendance(
    @Param('id', PositiveIntPipe) id: number,
    @Body() dto: SetInstructorAttendanceDto,
    @Req() req: Request & { user?: JwtClaims },
  ) {
    return this.schedule.setInstructorAttendance(id, dto, req.user?.sub, req.user?.effectiveCapabilities ?? []);
  }

  @Delete(':id/instructor-attendance')
  @RequireCapabilities('attendance.manage')
  @ApiParam({ name: 'id', description: '세션 id' })
  @ApiOperation({ summary: '강사 출결 미선택 복귀 — 사유·회계 영향 ACK·held 자동 역전이, 대표 권한.' })
  @ApiOkResponse({ description: '{ row, accountingImpact?, accountingImpactHash? }' })
  @ApiConflictResponse({ type: SessionAccountingImpactConflictResponseDto })
  clearInstructorAttendance(
    @Param('id', PositiveIntPipe) id: number,
    @Body() dto: ClearInstructorAttendanceDto,
    @Req() req: Request & { user?: JwtClaims },
  ) {
    return this.schedule.clearInstructorAttendance(id, dto, req.user?.sub, req.user?.effectiveCapabilities ?? []);
  }

  // [TBO-74C-2] 종속 행 없는 단일 세션 복구는 무결성을 깨뜨리므로 현재 fail-closed.
  @Post(':id/restore')
  @RequireCapabilities('calendar.manage')
  @ApiParam({ name: 'id', description: '세션 id' })
  @ApiOperation({ summary: '삭제 회차 복구(현재 비활성) — aggregate 복구 미구현으로 409. [매니저 이상]' })
  restore(@Param('id', PositiveIntPipe) id: number, @Req() req: Request & { user?: JwtClaims }) {
    return this.schedule.restoreSession(id, req.user?.sub);
  }

  // [TBO-64 2026-07-24] 회차 가격 책정(시수 워크시트) — 지각·리포트 미작성 회차의 수동 금액 확정.
  @Put(':id/pay-amount')
  @UseGuards(SudoGuard)
  @RequireCapabilities('finance.access')
  @ApiParam({ name: 'id', description: '세션 id' })
  @ApiOperation({ summary: '회차 가격 책정(정산 연결 전) — 지각·리포트 미작성 회차 수동 금액, null=해제. 재인증 필수, 연결된 회차 409. [대표]' })
  setPayAmount(
    @Param('id', PositiveIntPipe) id: number,
    @Body() dto: SetSessionPayAmountDto,
    @Req() req: Request & { user?: JwtClaims },
  ) {
    return this.schedule.setSessionPayAmount(id, dto.amount ?? null, req.user?.sub);
  }

  // 세션 삭제
  @Delete(':id')
  @RequireCapabilities('calendar.manage') // 수업 삭제 manager 이상(soft delete)
  @ApiParam({ name: 'id', description: '세션 id' })
  @ApiQuery({ name: 'scope', required: false, enum: ['this', 'this_and_following', 'all'], description: '[TBO-29C C3] 반복 삭제 범위(기본 this). payout lock은 전 회차 사전 검증 — 하나라도 걸리면 전체 불변' })
  @ApiQuery({ name: 'expectedSeriesVersion', required: false, description: '[C3] series edit CAS — 불일치 시 409 SERIES_VERSION_STALE' })
  @ApiQuery({ name: 'acknowledgeAccountingImpact', required: false, type: Boolean, description: '시수·정산 영향 미리보기를 확인한 뒤 true로 재요청' })
  @ApiQuery({ name: 'expectedAccountingImpactHash', required: false, description: '직전 409 영향 미리보기의 impactHash. 잠금 후 값이 달라지면 재확인 409' })
  @ApiOkResponse({ description: '{ id, deleted, removedIds: number[] }' })
  @ApiConflictResponse({
    type: SessionAccountingImpactConflictResponseDto,
    description: '시수·정산 영향 확인 또는 지급 회수 필요.',
  })
  @ApiOperation({ summary: '세션 삭제(반복 scope 지원) [로그인]' })
  remove(
    @Param('id', PositiveIntPipe) id: number,
    @Req() req: Request & { user?: JwtClaims },
    @Query('scope') scope?: string,
    @Query('expectedSeriesVersion', OptionalPositiveIntPipe)
    expectedSeriesVersion?: number,
    @Query('acknowledgeAccountingImpact') acknowledgeAccountingImpact?: string,
    @Query('expectedAccountingImpactHash') expectedAccountingImpactHash?: string,
  ) {
    if (scope != null && !['this', 'this_and_following', 'all'].includes(scope))
      throw new BadRequestException('scope는 this|this_and_following|all 중 하나여야 합니다');
    if (acknowledgeAccountingImpact != null && !['true', 'false'].includes(acknowledgeAccountingImpact))
      throw new BadRequestException('acknowledgeAccountingImpact는 true 또는 false여야 합니다');
    if (expectedAccountingImpactHash != null && !/^[a-f0-9]{64}$/.test(expectedAccountingImpactHash))
      throw new BadRequestException('expectedAccountingImpactHash는 64자리 sha256 hex여야 합니다');
    return this.schedule.remove(id, req.user?.sub, {
      scope: (scope ?? 'this') as 'this' | 'this_and_following' | 'all',
      expectedSeriesVersion,
      acknowledgeAccountingImpact: acknowledgeAccountingImpact === 'true',
      expectedAccountingImpactHash,
    }); // actor → soft delete deletedBy + audit 스냅샷
  }
}
