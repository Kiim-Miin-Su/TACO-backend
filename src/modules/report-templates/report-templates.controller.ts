import { Body, Controller, Delete, Get, Param, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { PositiveIntPipe } from '../../common/positive-int.pipe';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { ReportTemplatesService } from './report-templates.service';
import { CreateReportTemplateDto } from './dto/create-report-template.dto';
import { UpdateReportTemplateDto } from './dto/update-report-template.dto';
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
  @ApiOperation({ summary: '수업 리포트 템플릿 목록 조회 [전 직원]' })
  findAll() {
    // [TBO-56 C2b] 목록 READ = DB 권위(findActive) — 메모리 미러 직접 반환 제거.
    return this.templates.listDb();
  }

  @Post()
  @Roles(...STAFF_ROLES)
  @ApiOperation({ summary: '수업 리포트 템플릿 생성 [전 직원]' })
  create(@Body() dto: CreateReportTemplateDto, @Req() req: Request & { user?: JwtClaims }) {
    return this.templates.create(dto, req.user?.sub);
  }

  @Patch(':id')
  @Roles(...STAFF_ROLES)
  @ApiOperation({ summary: '수업 리포트 템플릿 수정 [작성자·매니저 이상]' })
  update(
    @Param('id', PositiveIntPipe) id: number,
    @Body() dto: UpdateReportTemplateDto,
    @Req() req: Request & { user?: JwtClaims },
  ) {
    return this.templates.update(id, dto, req.user?.sub, req.user?.roles);
  }

  @Delete(':id')
  @Roles(...STAFF_ROLES)
  @ApiOperation({ summary: '수업 리포트 템플릿 soft delete [작성자·매니저 이상]' })
  remove(@Param('id', PositiveIntPipe) id: number, @Req() req: Request & { user?: JwtClaims }) {
    return this.templates.remove(id, req.user?.sub, req.user?.roles);
  }
}
