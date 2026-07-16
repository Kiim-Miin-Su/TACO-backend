import { Body, Controller, Delete, Get, Param, ParseIntPipe, Post, Req, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { ReportTemplatesService } from './report-templates.service';
import { CreateReportTemplateDto } from './dto/create-report-template.dto';
import { RolesGuard } from '../auth/roles.guard';
import { Roles, STAFF_ROLES } from '../auth/roles.decorator';
import type { JwtClaims } from '../auth/auth.service';

// [참조/처리] /api/report-templates — 리포트 템플릿(강사 공용 자산). 로그인 직원 읽기·쓰기.
@ApiTags('report-templates')
@UseGuards(RolesGuard)
@Controller('report-templates')
export class ReportTemplatesController {
  constructor(private readonly templates: ReportTemplatesService) {}

  @Get()
  @Roles(...STAFF_ROLES)
  findAll() {
    return this.templates.findAll();
  }

  @Post()
  @Roles(...STAFF_ROLES)
  create(@Body() dto: CreateReportTemplateDto, @Req() req: Request & { user?: JwtClaims }) {
    return this.templates.create(dto, req.user?.sub);
  }

  @Delete(':id')
  @Roles(...STAFF_ROLES)
  remove(@Param('id', ParseIntPipe) id: number, @Req() req: Request & { user?: JwtClaims }) {
    return this.templates.remove(id, req.user?.sub);
  }
}
