import { Body, Controller, Get, Param, ParseIntPipe, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import type { JwtClaims } from '../auth/auth.service';
import { ApiTags, ApiOperation, ApiQuery, ApiBearerAuth, ApiParam, ApiCreatedResponse, ApiForbiddenResponse } from '@nestjs/swagger';
import { ReportsService } from './reports.service';
import { CreateReportDto } from './dto/create-report.dto';
import { UpdateReportDto } from './dto/update-report.dto';
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
  @Roles(...STAFF_ROLES) // [보안 2026-07-03] 사내 데이터 조회 — 로그인 필수
  @ApiOperation({ summary: '보고서 목록(sessionId 필터 가능)' })
  @ApiQuery({ name: 'sessionId', required: false })
  findAll(@Query('sessionId') sessionId?: string) {
    return sessionId ? this.reports.findBySession(Number(sessionId)) : this.reports.findAll();
  }

  @Get(':id')
  @Roles(...STAFF_ROLES) // [보안 2026-07-03] 사내 데이터 조회 — 로그인 필수
  @ApiOperation({ summary: '보고서 단건 — 강사는 본인 보고서만(404→403 표준). [B7 E3 스코프 갭 수정]' })
  findOne(@Param('id', ParseIntPipe) id: number, @Req() req: Request & { user?: JwtClaims }) {
    return this.reports.findOne(id, req.user ? { id: req.user.sub, roles: req.user.roles } : undefined);
  }

  @Post()
  @Roles(...STAFF_ROLES)
  @ApiOperation({ summary: '보고서 작성(세션 FK·중복·강사 일치·소유권 검증). 기본 submitted(승인요청).' })
  create(@Body() dto: CreateReportDto, @Req() req: Request & { user?: JwtClaims }) {
    // 소유권 검증(H2 IDOR): 비관리자는 본인 담당 세션만.
    return this.reports.create(dto, req.user ? { id: req.user.sub, roles: req.user.roles } : undefined);
  }

  // [E0.6 H1] 본문/숙제 수정(임시 저장) — 승인 전까지, 본인 보고서만.
  @Patch(':id')
  @Roles(...STAFF_ROLES)
  @ApiOperation({ summary: '보고서 본문/숙제 수정(승인 전) — 본인 보고서만. 기존 보고서 임시 저장 경로.' })
  update(@Param('id', ParseIntPipe) id: number, @Body() dto: UpdateReportDto, @Req() req: Request & { user?: JwtClaims }) {
    return this.reports.updateContent(id, dto, req.user ? { id: req.user.sub, roles: req.user.roles } : undefined);
  }

  @Post(':id/submit')
  @Roles(...STAFF_ROLES)
  @ApiOperation({ summary: '강사 제출(draft → submitted) — 본인 보고서만' })
  submit(@Param('id', ParseIntPipe) id: number, @Req() req: Request & { user?: JwtClaims }) {
    return this.reports.submit(id, req.user ? { id: req.user.sub, roles: req.user.roles } : undefined);
  }

  // 관리자 승인/반려 — RolesGuard로 super_admin/manager/admin만 허용.
  @Post(':id/approve')
  @Roles(...ADMIN_ROLES)
  @ApiParam({ name: 'id', description: '보고서 id' })
  @ApiOperation({ summary: '관리자 승인(submitted → approved) — 시수 적격 편입 [관리자]' })
  @ApiCreatedResponse({ description: 'SessionReport(approvalStatus=approved, approvedAt·approvedBy)' })
  @ApiForbiddenResponse({ description: '권한 없음(관리자 전용)' })
  approve(@Param('id', ParseIntPipe) id: number, @Req() req: Request & { user?: JwtClaims }, @Body() body?: ApproveReportDto) {
    return this.reports.approve(id, req.user?.sub ?? body?.approvedBy); // [감사 전수] actor는 토큰 권위
  }

  @Post(':id/reject')
  @Roles(...ADMIN_ROLES)
  @ApiParam({ name: 'id', description: '보고서 id' })
  @ApiOperation({ summary: '관리자 반려(→ rejected, 사유 보존) [관리자]' })
  @ApiCreatedResponse({ description: 'SessionReport(approvalStatus=rejected, rejectedReason)' })
  reject(@Param('id', ParseIntPipe) id: number, @Req() req: Request & { user?: JwtClaims }, @Body() body?: RejectReportDto) {
    return this.reports.reject(id, body?.reason, req.user?.sub); // [감사 전수 2026-07-16]
  }
}
