import { Body, Controller, Delete, Get, Param, ParseIntPipe, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { SubjectsService } from './subjects.service';
import { CreateSubjectDto } from './dto/create-subject.dto';
import { UpdateSubjectDto } from './dto/update-subject.dto';
import { RolesGuard } from '../auth/roles.guard';
import { Roles, ADMIN_ROLES, STAFF_ROLES } from '../auth/roles.decorator';
import type { JwtClaims } from '../auth/auth.service';

@ApiTags('subjects')
@UseGuards(RolesGuard)
@Controller('subjects')
export class SubjectsController {
  constructor(private readonly subjects: SubjectsService) {}

  @Get()
  @Roles(...STAFF_ROLES) // [보안 2026-07-03] 사내 데이터 조회 — 로그인 필수
  findAll() {
    return this.subjects.findAll();
  }

  @Get(':id')
  @Roles(...STAFF_ROLES) // [보안 2026-07-03] 사내 데이터 조회 — 로그인 필수
  findOne(@Param('id', ParseIntPipe) id: number) {
    return this.subjects.findOne(id);
  }

  @Post()
  @Roles(...ADMIN_ROLES)
  create(@Body() dto: CreateSubjectDto, @Req() req: Request & { user?: JwtClaims }) {
    return this.subjects.create(dto, req.user?.sub);
  }

  @Patch(':id')
  @Roles(...ADMIN_ROLES)
  update(@Param('id', ParseIntPipe) id: number, @Body() dto: UpdateSubjectDto, @Req() req: Request & { user?: JwtClaims }) {
    return this.subjects.update(id, dto, req.user?.sub);
  }

  @Delete(':id')
  @Roles(...ADMIN_ROLES)
  remove(@Param('id', ParseIntPipe) id: number, @Req() req: Request & { user?: JwtClaims }) {
    return this.subjects.remove(id, req.user?.sub);
  }
}
