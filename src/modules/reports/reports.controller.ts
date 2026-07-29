import { Body, Controller, Delete, Get, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import { OptionalPositiveIntPipe, PositiveIntPipe } from '../../common/positive-int.pipe';
import type { Request } from 'express';
import type { JwtClaims } from '../auth/auth.service';
import { ApiTags, ApiOperation, ApiQuery, ApiBearerAuth, ApiParam, ApiCreatedResponse, ApiForbiddenResponse } from '@nestjs/swagger';
import { ReportsService } from './reports.service';
import { CreateReportDto } from './dto/create-report.dto';
import { UpdateReportDto } from './dto/update-report.dto';
import { ApproveReportDto, RejectReportDto } from './dto/report-action.dto';
import { RolesGuard } from '../auth/roles.guard';
import { RequireCapabilities, Roles, STAFF_ROLES } from '../auth/roles.decorator';

@ApiTags('reports')
@ApiBearerAuth()
@UseGuards(RolesGuard)
@Controller('reports')
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  @Get()
  @Roles(...STAFF_ROLES) // [보안 2026-07-03] 사내 데이터 조회 — 로그인 필수
  @ApiOperation({ summary: '보고서 목록(sessionId 필터). 학생/학년/수업/과목/시간 조인 context 포함. 강사는 본인 일반 일정만.' })
  @ApiQuery({ name: 'sessionId', required: false })
  findAll(
    @Req() req: Request & { user?: JwtClaims },
    @Query('sessionId', OptionalPositiveIntPipe) sessionId?: number,
  ) {
    const actor = req.user ? { id: req.user.sub, roles: req.user.roles } : undefined;
    return this.reports.listDbForActor(actor, sessionId); // [TBO-54 C2] DB 권위 READ
  }

  @Get(':id')
  @Roles(...STAFF_ROLES) // [보안 2026-07-03] 사내 데이터 조회 — 로그인 필수
  @ApiOperation({ summary: '보고서 단건 + 서버 조인 context — 강사는 본인 보고서만(404→403 표준).' })
  findOne(@Param('id', PositiveIntPipe) id: number, @Req() req: Request & { user?: JwtClaims }) {
    return this.reports.getDbForActor(id, req.user ? { id: req.user.sub, roles: req.user.roles } : undefined); // [TBO-54 C2]
  }

  @Post()
  @Roles(...STAFF_ROLES)
  @ApiOperation({ summary: '보고서 작성(세션 FK·중복·강사 일치·소유권 검증). 기본 submitted(승인요청).' })
  create(@Body() dto: CreateReportDto, @Req() req: Request & { user?: JwtClaims }) {
    // 소유권 검증(H2 IDOR): 비관리자는 본인 담당 세션만.
    return this.reports.create(dto, req.user ? { id: req.user.sub, roles: req.user.roles } : undefined);
  }

  // [TBO-76 76D] 작성값 수정(임시 저장) — 승인 전까지, 본인 보고서만.
  @Patch(':id')
  @Roles(...STAFF_ROLES)
  @ApiOperation({ summary: '보고서 수업내용/진도페이지/숙제 수정(승인 전) — 본인 보고서만.' })
  update(@Param('id', PositiveIntPipe) id: number, @Body() dto: UpdateReportDto, @Req() req: Request & { user?: JwtClaims }) {
    return this.reports.updateContent(id, dto, req.user ? { id: req.user.sub, roles: req.user.roles } : undefined);
  }

  @Delete(':id')
  @Roles(...STAFF_ROLES)
  @ApiOperation({ summary: '잘못 만든 draft 보고서 철회(soft delete) — 작성자 본인 또는 관리자.' })
  remove(@Param('id', PositiveIntPipe) id: number, @Req() req: Request & { user?: JwtClaims }) {
    return this.reports.removeDraft(id, req.user ? { id: req.user.sub, roles: req.user.roles } : undefined);
  }

  @Post(':id/submit')
  @Roles(...STAFF_ROLES)
  @ApiOperation({ summary: '강사 제출(draft → submitted) — 본인 보고서만' })
  submit(@Param('id', PositiveIntPipe) id: number, @Req() req: Request & { user?: JwtClaims }) {
    return this.reports.submit(id, req.user ? { id: req.user.sub, roles: req.user.roles } : undefined);
  }

  // 관리자 승인/반려 — RolesGuard로 super_admin/manager/admin만 허용.
  @Post(':id/approve')
  @RequireCapabilities('approval.manage')
  @ApiParam({ name: 'id', description: '보고서 id' })
  @ApiOperation({ summary: '관리자 승인(submitted → approved) — 시수 적격 편입 [관리자]' })
  @ApiCreatedResponse({ description: 'SessionReport(approvalStatus=approved, approvedAt·approvedBy)' })
  @ApiForbiddenResponse({ description: '권한 없음(관리자 전용)' })
  approve(@Param('id', PositiveIntPipe) id: number, @Req() req: Request & { user?: JwtClaims }, @Body() body?: ApproveReportDto) {
    return this.reports.approve(id, req.user?.sub ?? body?.approvedBy); // [감사 전수] actor는 토큰 권위
  }

  @Post(':id/reject')
  @RequireCapabilities('approval.manage')
  @ApiParam({ name: 'id', description: '보고서 id' })
  @ApiOperation({ summary: '관리자 반려(→ rejected, 사유 보존) [관리자]' })
  @ApiCreatedResponse({ description: 'SessionReport(approvalStatus=rejected, rejectedReason)' })
  reject(@Param('id', PositiveIntPipe) id: number, @Req() req: Request & { user?: JwtClaims }, @Body() body?: RejectReportDto) {
    return this.reports.reject(id, body?.reason, req.user?.sub); // [감사 전수 2026-07-16]
  }
}
