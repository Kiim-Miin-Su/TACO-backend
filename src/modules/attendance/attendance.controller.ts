import { Body, Controller, Delete, Get, Param, Put, Query, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import type { JwtClaims } from '../auth/auth.service';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiOkResponse, ApiQuery } from '@nestjs/swagger';
import { AttendanceService } from './attendance.service';
import { UpsertAttendanceDto } from './dto/upsert-attendance.dto';
import { ClearAttendanceDto } from './dto/clear-attendance.dto';
import { RolesGuard } from '../auth/roles.guard';
import { RequireCapabilities, Roles, STAFF_ROLES } from '../auth/roles.decorator';
import { OptionalPositiveIntPipe, PositiveIntPipe } from '../../common/positive-int.pipe';

// [참조/처리] /api/attendance REST. @Roles(STAFF_ROLES) → 로그인 필수(강사 포함, 관리자 한정 아님).
//  - RolesGuard는 @Roles 있는 라우트만 검사하므로, 로그인 강제하려면 STAFF_ROLES 명시가 필요.
//  - GET(?sessionId): 전체 또는 세션별 출결. PUT: (session,student) upsert(FK 검증 400).
//  프론트 api.attendance가 호출, AppShell이 GET으로 store 하이드레이트, ClassSessionDetailView가 PUT.
@ApiTags('attendance')
@ApiBearerAuth()
@UseGuards(RolesGuard)
@Controller('attendance')
export class AttendanceController {
  constructor(private readonly attendance: AttendanceService) {}

  @Get()
  @Roles(...STAFF_ROLES) // 로그인 필수
  @ApiOperation({ summary: '출결 목록(Attendance[]) — sessionId 지정 시 해당 세션만' })
  @ApiQuery({ name: 'sessionId', required: false, type: Number })
  @ApiOkResponse({ description: 'Attendance[] — sessionId·studentId·status' })
  findAll(
    @Req() req: Request & { user?: JwtClaims },
    @Query('sessionId', OptionalPositiveIntPipe) sessionId?: number,
  ) {
    // [TBO-56 C2b] DB 권위 READ — 행 findActive + 강사 스코프 세션 재수화 판정
    return this.attendance.listDbForActor(req.user?.sub, req.user?.roles, sessionId);
  }

  @Put()
  @RequireCapabilities('attendance.manage')
  @ApiOperation({ summary: '학생 출결 기록(upsert) — (세션,학생) 1행. FK·유니크 무결성 보장 [대표]' })
  @ApiOkResponse({ description: 'upsert된 Attendance' })
  upsert(@Body() dto: UpsertAttendanceDto, @Req() req: Request & { user?: JwtClaims }) {
    // actor(sub·roles) → 소유권 검증(H1 IDOR) + audit_log(출결 변경 이력)
    return this.attendance.upsert(dto, req.user?.sub, req.user?.effectiveCapabilities);
  }

  @Delete(':sessionId/:studentId')
  @RequireCapabilities('attendance.manage')
  @ApiOperation({ summary: '학생 출결 초기화 — 대표, 사유·감사 이력 필수' })
  @ApiOkResponse({ description: '{ id, sessionId, studentId, deleted: true }' })
  clear(
    @Param('sessionId', PositiveIntPipe) sessionId: number,
    @Param('studentId', PositiveIntPipe) studentId: number,
    @Body() dto: ClearAttendanceDto,
    @Req() req: Request & { user?: JwtClaims },
  ) {
    return this.attendance.clear(sessionId, studentId, dto.reason, req.user?.sub, req.user?.effectiveCapabilities, dto);
  }
}
