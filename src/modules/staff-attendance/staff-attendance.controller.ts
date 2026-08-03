import { Body, Controller, Delete, Get, Param, Put, Query, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import type { JwtClaims } from '../auth/auth.service';
import { RequireCapabilities } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { PositiveIntPipe } from '../../common/positive-int.pipe';
import {
  DeleteStaffAttendanceDto,
  InstructorAttendanceLedgerQueryDto,
  ListStaffAttendanceQueryDto,
  UpsertStaffAttendanceDto,
} from './dto/staff-attendance.dto';
import { StaffAttendanceService } from './staff-attendance.service';

@ApiTags('staff-attendance')
@ApiBearerAuth()
@UseGuards(RolesGuard)
@RequireCapabilities('admin.area')
@Controller('staff-attendance')
export class StaffAttendanceController {
  constructor(private readonly attendance: StaffAttendanceService) {}

  @Get()
  @ApiOperation({ summary: '직원 일별 출결 목록 - 기간·직원·상태 필터 [매니저 이상]' })
  @ApiOkResponse({ description: 'StaffAttendanceRecord[]' })
  list(@Query() query: ListStaffAttendanceQueryDto) {
    return this.attendance.list(query);
  }

  @Get('instructor-ledger')
  @ApiOperation({ summary: '강사 수업 출결+직원 일별 출결 통합 ledger [매니저 이상]' })
  @ApiOkResponse({ description: 'InstructorAttendanceLedger - 기간 합성 read projection' })
  ledger(@Query() query: InstructorAttendanceLedgerQueryDto) {
    return this.attendance.instructorLedger(query);
  }

  @Put()
  @ApiOperation({ summary: '직원·업무일 기준 일별 출결 생성 또는 수정 [매니저 이상]' })
  @ApiOkResponse({ description: '저장된 StaffAttendanceRecord' })
  upsert(
    @Body() dto: UpsertStaffAttendanceDto,
    @Req() req: Request & { user?: JwtClaims },
  ) {
    return this.attendance.upsert(dto, req.user!.sub);
  }

  @Delete(':id')
  @ApiOperation({ summary: '직원 일별 출결 soft-delete, 사유 필수 [매니저 이상]' })
  @ApiOkResponse({ description: '{ id, deleted: true }' })
  remove(
    @Param('id', PositiveIntPipe) id: number,
    @Body() dto: DeleteStaffAttendanceDto,
    @Req() req: Request & { user?: JwtClaims },
  ) {
    return this.attendance.remove(id, dto.reason, req.user!.sub);
  }
}

