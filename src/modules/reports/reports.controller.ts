import { Body, Controller, Get, Param, ParseIntPipe, Post, Query } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiQuery } from '@nestjs/swagger';
import { ReportsService } from './reports.service';
import { CreateReportDto } from './dto/create-report.dto';

@ApiTags('reports')
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
  @ApiOperation({ summary: '보고서 작성(세션 FK·중복·강사 일치 검증). 기본 submitted(승인요청).' })
  create(@Body() dto: CreateReportDto) {
    return this.reports.create(dto);
  }

  @Post(':id/submit')
  @ApiOperation({ summary: '강사 제출(draft → submitted)' })
  submit(@Param('id', ParseIntPipe) id: number) {
    return this.reports.submit(id);
  }

  // super_admin 승인/반려 (인증 Guard는 추후 연결 — expenses 패턴과 동일)
  @Post(':id/approve')
  @ApiOperation({ summary: '관리자 승인(submitted → approved) — 시수 적격 편입' })
  approve(@Param('id', ParseIntPipe) id: number, @Body() body?: { approvedBy?: number }) {
    return this.reports.approve(id, body?.approvedBy);
  }

  @Post(':id/reject')
  @ApiOperation({ summary: '관리자 반려(→ rejected, 사유 보존)' })
  reject(@Param('id', ParseIntPipe) id: number, @Body() body?: { reason?: string }) {
    return this.reports.reject(id, body?.reason);
  }
}
