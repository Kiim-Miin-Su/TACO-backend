import { Body, Controller, Get, Put, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiOkResponse, ApiQuery } from '@nestjs/swagger';
import { AttendanceService } from './attendance.service';
import { UpsertAttendanceDto } from './dto/upsert-attendance.dto';
import { RolesGuard } from '../auth/roles.guard';
import { Roles, STAFF_ROLES } from '../auth/roles.decorator';

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
  findAll(@Query('sessionId') sessionId?: string) {
    if (sessionId !== undefined) return this.attendance.findBySession(Number(sessionId));
    return this.attendance.findAll();
  }

  @Put()
  @Roles(...STAFF_ROLES) // 로그인 필수(강사가 마킹)
  @ApiOperation({ summary: '출결 기록(upsert) — (세션,학생) 1행. FK·유니크 무결성 보장' })
  @ApiOkResponse({ description: 'upsert된 Attendance' })
  upsert(@Body() dto: UpsertAttendanceDto) {
    return this.attendance.upsert(dto);
  }
}
