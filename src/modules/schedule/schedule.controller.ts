import { Body, Controller, Delete, Get, Param, ParseIntPipe, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiQuery, ApiBearerAuth, ApiParam, ApiCreatedResponse, ApiOkResponse, ApiConflictResponse, ApiUnauthorizedResponse } from '@nestjs/swagger';
import { ScheduleService } from './schedule.service';
import { UpdateScheduleDto } from './dto/update-schedule.dto';
import { CreateScheduleDto } from './dto/create-schedule.dto';
import { ConflictCheckDto } from './dto/conflict-check.dto';
import { RolesGuard } from '../auth/roles.guard';
import { Roles, STAFF_ROLES } from '../auth/roles.decorator';

@ApiTags('scheduling')
@ApiBearerAuth()
@UseGuards(RolesGuard)
@Controller('schedule')
export class ScheduleController {
  constructor(private readonly schedule: ScheduleService) {}

  // GET /api/schedule?from=YYYY-MM-DD&to=YYYY-MM-DD&instructorId=&roomId=&studentId=
  @Get()
  @Roles(...STAFF_ROLES) // [보안 2026-07-03] 사내 데이터 조회 — 로그인 필수
  @ApiOperation({ summary: '스케줄 조회(기간·강사·강의실·학생 필터). studentId는 학생 활성 수강 코스의 세션만.' })
  @ApiQuery({ name: 'from', required: false }) @ApiQuery({ name: 'to', required: false })
  @ApiQuery({ name: 'instructorId', required: false }) @ApiQuery({ name: 'roomId', required: false })
  @ApiQuery({ name: 'studentId', required: false, description: '학생 코호트(enrollment status≠drop) 역추적' })
  list(
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('instructorId') instructorId?: string,
    @Query('roomId') roomId?: string,
    @Query('studentId') studentId?: string,
  ) {
    return this.schedule.list({
      from,
      to,
      instructorId: instructorId ? Number(instructorId) : undefined,
      roomId: roomId ? Number(roomId) : undefined,
      studentId: studentId ? Number(studentId) : undefined,
    });
  }

  // GET /api/schedule/resources — 자원 피커(강사·강의실·학생·코스)
  @Get('resources')
  @Roles(...STAFF_ROLES) // [보안 2026-07-03] 사내 데이터 조회 — 로그인 필수
  @ApiOperation({ summary: '자원 피커 — 강사·강의실·학생·코스 옵션(FK 정렬). 좌측 레일·배정 폼용.' })
  resources() {
    return this.schedule.resources();
  }

  // 충돌 드라이런(생성·이동 전 검사)
  @Post('conflicts')
  @Roles(...STAFF_ROLES) // [코드리뷰 2026-07-03 H1] @Roles 누락 → 무인증 접근 가능했음. 강사·강의실 가용성 탐지 차단
  @ApiOperation({ summary: '충돌 드라이런 — 생성·이동 전 강사·강의실 이중예약/불가시간 겹침 검사 [로그인]' })
  @ApiOkResponse({ description: 'Conflict[] — 각 항목 { type, resource, resourceId, sessionId?, detail? }' })
  conflicts(@Body() body: ConflictCheckDto) {
    return this.schedule.checkConflicts(body);
  }

  // POST /api/schedule — 세션 생성(추천→배정·수동 추가). 충돌 시 409(force=true면 적용).
  @Post()
  @Roles(...STAFF_ROLES) // 로그인 필수(강사 본인 일정 포함) — 비로그인 401
  @ApiOperation({ summary: '세션 생성(추천→배정·수동). FK 검증 + 충돌 검사(409 / force=true 강제). [로그인]' })
  @ApiCreatedResponse({ description: '{ row: ScheduleRow(enriched: 강사·과목·강의실명 포함), conflicts: Conflict[] }' })
  @ApiConflictResponse({ description: '{ message, conflicts: Conflict[] } — force=false에서 충돌 시' })
  @ApiUnauthorizedResponse({ description: '토큰 없음(로그인 필요)' })
  create(@Body() dto: CreateScheduleDto) {
    return this.schedule.create(dto);
  }

  // 이동·리사이즈·상세편집. 충돌 시 409 {message, conflicts} (force=true면 적용).
  @Patch(':id')
  @Roles(...STAFF_ROLES) // 로그인 필수
  @ApiParam({ name: 'id', description: '세션 id' })
  @ApiOperation({ summary: '세션 이동·리사이즈·상세편집(반복 scope 지원). 충돌 시 409. [로그인]' })
  @ApiOkResponse({ description: '{ row: ScheduleRow, conflicts: Conflict[], updated: number(시리즈 동반 수) }' })
  @ApiConflictResponse({ description: '{ message, conflicts } — force=false에서 충돌 시' })
  update(@Param('id', ParseIntPipe) id: number, @Body() dto: UpdateScheduleDto) {
    return this.schedule.update(id, dto);
  }

  // 세션 삭제
  @Delete(':id')
  @Roles(...STAFF_ROLES) // 로그인 필수
  @ApiParam({ name: 'id', description: '세션 id' })
  @ApiOkResponse({ description: '{ id, deleted: true }' })
  @ApiOperation({ summary: '세션 삭제 [로그인]' })
  remove(@Param('id', ParseIntPipe) id: number) {
    return this.schedule.remove(id);
  }
}
