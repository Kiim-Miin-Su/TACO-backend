import { Body, Controller, Get, Param, ParseIntPipe, Post, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiQuery, ApiBearerAuth, ApiParam, ApiCreatedResponse, ApiForbiddenResponse } from '@nestjs/swagger';
import { ReportsService } from './reports.service';
import { CreateReportDto } from './dto/create-report.dto';
import { ApproveReportDto, RejectReportDto } from './dto/report-action.dto';
import { RolesGuard } from '../auth/roles.guard';
import { Roles, ADMIN_ROLES, STAFF_ROLES } from '../auth/roles.decorator';

@ApiTags('reports')
@ApiBearerAuth()
@UseGuards(RolesGuard)
@Controller('reports')
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  @Get()
  @ApiOperation({ summary: '보고서 목록(sessionId 필터 가능)' })
  @ApiQuery({ name: 'sessionId', required: false })
  findAll(@Query('sessionId') sessionId?: string) {
    return sessionId ? this.reports.findBySession(Number(sessionId)) : this.reports.findAll();
  }

  @Get(':id')
  findOne(@Param('id', ParseIntPipe) id: number) {
    return this.reports.findOne(id);
  }

  @Post()
  @Roles(...STAFF_ROLES)
  @ApiOperation({ summary: '보고서 작성(세션 FK·중복·강사 일치 검증). 기본 submitted(승인요청).' })
  create(@Body() dto: CreateReportDto) {
    return this.reports.create(dto);
  }

  @Post(':id/submit')
  @Roles(...STAFF_ROLES)
  @ApiOperation({ summary: '강사 제출(draft → submitted)' })
  submit(@Param('id', ParseIntPipe) id: number) {
    return this.reports.submit(id);
  }

  // 관리자 승인/반려 — RolesGuard로 super_admin/manager/admin만 허용.
  @Post(':id/approve')
  @Roles(...ADMIN_ROLES)
  @ApiParam({ name: 'id', description: '보고서 id' })
  @ApiOperation({ summary: '관리자 승인(submitted → approved) — 시수 적격 편입 [관리자]' })
  @ApiCreatedResponse({ description: 'SessionReport(status=approved, approvedAt·approvedBy)' })
  @ApiForbiddenResponse({ description: '권한 없음(관리자 전용)' })
  approve(@Param('id', ParseIntPipe) id: number, @Body() body?: ApproveReportDto) {
    return this.reports.approve(id, body?.approvedBy);
  }

  @Post(':id/reject')
  @Roles(...ADMIN_ROLES)
  @ApiParam({ name: 'id', description: '보고서 id' })
  @ApiOperation({ summary: '관리자 반려(→ rejected, 사유 보존) [관리자]' })
  @ApiCreatedResponse({ description: 'SessionReport(status=rejected, rejectedReason)' })
  reject(@Param('id', ParseIntPipe) id: number, @Body() body?: RejectReportDto) {
    return this.reports.reject(id, body?.reason);
  }
}
