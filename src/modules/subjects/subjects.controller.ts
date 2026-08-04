import { Body, Controller, Delete, Get, Param, Patch, Post, Req } from '@nestjs/common';
import { PositiveIntPipe } from '../../common/positive-int.pipe';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { SubjectsService } from './subjects.service';
import { CreateSubjectDto } from './dto/create-subject.dto';
import { UpdateSubjectDto } from './dto/update-subject.dto';
import { Roles, ADMIN_ROLES, STAFF_ROLES } from '../auth/roles.decorator';
import type { JwtClaims } from '../auth/auth.service';

@ApiTags('subjects')
@Controller('subjects')
export class SubjectsController {
  constructor(private readonly subjects: SubjectsService) {}

  @Get()
  @Roles(...STAFF_ROLES) // [보안 2026-07-03] 사내 데이터 조회 — 로그인 필수
  @ApiOperation({ summary: '과목 카탈로그 목록 조회 [전 직원]' })
  findAll() {
    return this.subjects.findAllFresh();
  }

  @Get(':id')
  @Roles(...STAFF_ROLES) // [보안 2026-07-03] 사내 데이터 조회 — 로그인 필수
  @ApiOperation({ summary: '과목 카탈로그 단건 조회 [전 직원]' })
  findOne(@Param('id', PositiveIntPipe) id: number) {
    return this.subjects.findOneFresh(id);
  }

  @Post()
  @Roles(...ADMIN_ROLES)
  @ApiOperation({ summary: '과목 카탈로그 생성 [매니저 이상]' })
  create(@Body() dto: CreateSubjectDto, @Req() req: Request & { user?: JwtClaims }) {
    return this.subjects.create(dto, req.user?.sub);
  }

  @Patch(':id')
  @Roles(...ADMIN_ROLES)
  @ApiOperation({ summary: '과목 카탈로그 수정 [매니저 이상]' })
  update(@Param('id', PositiveIntPipe) id: number, @Body() dto: UpdateSubjectDto, @Req() req: Request & { user?: JwtClaims }) {
    return this.subjects.update(id, dto, req.user?.sub);
  }

  @Delete(':id')
  @Roles(...ADMIN_ROLES)
  @ApiOperation({ summary: '수업 참조 확인 후 과목 삭제 [매니저 이상]' })
  remove(@Param('id', PositiveIntPipe) id: number, @Req() req: Request & { user?: JwtClaims }) {
    return this.subjects.remove(id, req.user?.sub);
  }
}
