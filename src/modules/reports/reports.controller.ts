import { Body, Controller, Delete, Get, Param, Patch, Post, Query, Req } from '@nestjs/common';
import { PositiveIntPipe } from '../../common/positive-int.pipe';
import type { Request } from 'express';
import type { JwtClaims } from '../auth/auth.service';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiParam, ApiCreatedResponse, ApiForbiddenResponse } from '@nestjs/swagger';
import { ReportsService } from './reports.service';
import { CreateReportDto } from './dto/create-report.dto';
import { UpdateReportDto } from './dto/update-report.dto';
import { ApproveReportDto, RejectReportDto } from './dto/report-action.dto';
import { RequireCapabilities, Roles, STAFF_ROLES } from '../auth/roles.decorator';
import { ListReportsQueryDto, ReportWorklistQueryDto } from './dto/list-reports-query.dto';
import { ReviseApprovedReportDto } from './dto/revise-report.dto';

@ApiTags('reports')
@ApiBearerAuth()
@Controller('reports')
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  @Get()
  @Roles(...STAFF_ROLES) // [보안 2026-07-03] 사내 데이터 조회 — 로그인 필수
  @ApiOperation({ summary: '보고서 목록(기간·학생·과목·강사·상태 필터). 보존된 과거 원부까지 조인한 context 포함, 강사는 JWT 본인 범위.' })
  findAll(
    @Req() req: Request & { user?: JwtClaims },
    @Query() query: ListReportsQueryDto,
  ) {
    const actor = req.user ? { id: req.user.sub, roles: req.user.roles } : undefined;
    return this.reports.listDbForActor(actor, query); // [TBO-54 C2] DB 권위 READ
  }

  @Get('worklist')
  @Roles(...STAFF_ROLES)
  @ApiOperation({ summary: '종료된 진행완료 수업의 학생별 리포트 작성 필요 목록. 목록·배지 공용 서버 모집단.' })
  worklist(
    @Req() req: Request & { user?: JwtClaims },
    @Query() query: ReportWorklistQueryDto,
  ) {
    const actor = req.user ? { id: req.user.sub, roles: req.user.roles } : undefined;
    return this.reports.worklistDbForActor(actor, query);
  }

  @Get(':id')
  @Roles(...STAFF_ROLES) // [보안 2026-07-03] 사내 데이터 조회 — 로그인 필수
  @ApiOperation({ summary: '보고서 단건 + 보존된 과거 원부 서버 조인 context — 강사는 본인 보고서만(404→403 표준).' })
  findOne(@Param('id', PositiveIntPipe) id: number, @Req() req: Request & { user?: JwtClaims }) {
    return this.reports.getDbForActor(id, req.user ? { id: req.user.sub, roles: req.user.roles } : undefined); // [TBO-54 C2]
  }

  @Post()
  @RequireCapabilities('report.write') // [TBO-86I-2] 작성 표면 공통 판정 — 소유권은 서비스가 검증
  @ApiOperation({ summary: '보고서 작성(강사 본인 또는 관리자 대리 작성, 세션 FK·중복·담당 강사·참여 학생 검증). 기본 submitted(승인요청).' })
  create(@Body() dto: CreateReportDto, @Req() req: Request & { user?: JwtClaims }) {
    // 소유권 검증(H2 IDOR): 비관리자는 본인 담당 세션만.
    return this.reports.create(dto, req.user ? { id: req.user.sub, roles: req.user.roles } : undefined);
  }

  // [TBO-76 76D] 작성값 수정(임시 저장) — 승인 전까지, 본인 보고서만.
  @Patch(':id')
  @RequireCapabilities('report.write') // [TBO-86I-2] 작성 표면 공통 판정 — 소유권은 서비스가 검증
  @ApiOperation({ summary: '보고서 수업내용/진도페이지/숙제 수정(승인 전) — 본인 보고서만.' })
  update(@Param('id', PositiveIntPipe) id: number, @Body() dto: UpdateReportDto, @Req() req: Request & { user?: JwtClaims }) {
    return this.reports.updateContent(id, dto, req.user ? { id: req.user.sub, roles: req.user.roles } : undefined);
  }

  @Delete(':id')
  @RequireCapabilities('report.write') // [TBO-86I-2] 작성 표면 공통 판정 — 소유권은 서비스가 검증
  @ApiOperation({ summary: '잘못 만든 draft 보고서 철회(soft delete) — 작성자 본인 또는 관리자.' })
  remove(@Param('id', PositiveIntPipe) id: number, @Req() req: Request & { user?: JwtClaims }) {
    return this.reports.removeDraft(id, req.user ? { id: req.user.sub, roles: req.user.roles } : undefined);
  }

  @Post(':id/submit')
  @RequireCapabilities('report.write') // [TBO-86I-2] 작성 표면 공통 판정 — 소유권은 서비스가 검증
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
  approve(
    @Param('id', PositiveIntPipe) id: number,
    @Req() req: Request & { user?: JwtClaims },
    @Body() _body: ApproveReportDto, // [TBO-79 C2] 빈 DTO 바인딩 유지 = actor 필드 재유입을 400으로 차단
  ) {
    return this.reports.approve(id, req.user?.sub); // actor는 토큰만 권위 — body fallback 제거
  }

  @Get(':id/revisions')
  @RequireCapabilities('approval.manage')
  @ApiOperation({ summary: '승인 후 보고서 본문 수정 원장 조회 [관리자]' })
  revisions(@Param('id', PositiveIntPipe) id: number) {
    return this.reports.listRevisions(id);
  }

  @Post(':id/revise')
  @RequireCapabilities('approval.manage')
  @ApiOperation({ summary: '승인된 보고서 본문 수정 + append-only revision + audit [관리자]' })
  revise(
    @Param('id', PositiveIntPipe) id: number,
    @Body() body: ReviseApprovedReportDto,
    @Req() req: Request & { user?: JwtClaims },
  ) {
    return this.reports.reviseApproved(id, body, req.user?.sub);
  }

  @Post(':id/reject')
  @RequireCapabilities('approval.manage')
  @ApiParam({ name: 'id', description: '보고서 id' })
  @ApiOperation({ summary: '관리자 반려(→ rejected, 사유 보존) [관리자]' })
  @ApiCreatedResponse({ description: 'SessionReport(approvalStatus=rejected, rejectedReason)' })
  reject(@Param('id', PositiveIntPipe) id: number, @Req() req: Request & { user?: JwtClaims }, @Body() body?: RejectReportDto) {
    return this.reports.reject(id, body?.reason, req.user?.sub, body); // [TBO-79 B5] ack 전달 // [감사 전수 2026-07-16]
  }
}
