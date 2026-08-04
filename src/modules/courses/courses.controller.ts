import { Body, Controller, Delete, Get, Param, Patch, Post, Req } from '@nestjs/common';
import { PositiveIntPipe } from '../../common/positive-int.pipe';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { CoursesService } from './courses.service';
import { CreateCourseDto } from './dto/create-course.dto';
import { UpdateCourseDto } from './dto/update-course.dto';
import { Roles, ADMIN_ROLES, STAFF_ROLES, isInstructorOnly } from '../auth/roles.decorator';
import type { JwtClaims } from '../auth/auth.service';

@ApiTags('courses')
@Controller('courses')
export class CoursesController {
  constructor(private readonly courses: CoursesService) {}

  @Get()
  @Roles(...STAFF_ROLES) // [보안 2026-07-03] 사내 데이터 조회 — 로그인 필수
  @ApiOperation({ summary: '수업 목록 조회 [전 직원]' })
  findAll(@Req() req: Request & { user?: JwtClaims }) {
    return this.courses.findAllFreshForActor(isInstructorOnly(req.user?.roles));
  }

  @Get(':id')
  @Roles(...STAFF_ROLES) // [보안 2026-07-03] 사내 데이터 조회 — 로그인 필수
  @ApiOperation({ summary: '수업 단건 및 담당 강사별 페이 override 조회 [전 직원]' })
  findOne(@Param('id', PositiveIntPipe) id: number, @Req() req: Request & { user?: JwtClaims }) {
    return this.courses.findOneFreshForActor(id, isInstructorOnly(req.user?.roles));
  }

  @Post()
  @Roles(...ADMIN_ROLES)
  @ApiOperation({ summary: '수업 개설 및 담당 강사 기본 페이 적용 [매니저 이상]' })
  create(@Body() dto: CreateCourseDto, @Req() req: Request & { user?: JwtClaims }) {
    return this.courses.create(dto, req.user?.sub);
  }

  @Patch(':id')
  @Roles(...ADMIN_ROLES)
  @ApiOperation({ summary: '수업과 강사별 페이 override 수정 [매니저 이상]' })
  update(@Param('id', PositiveIntPipe) id: number, @Body() dto: UpdateCourseDto, @Req() req: Request & { user?: JwtClaims }) {
    return this.courses.update(id, dto, req.user?.sub);
  }

  @Delete(':id')
  @Roles(...ADMIN_ROLES)
  @ApiOperation({ summary: '참조 무결성 확인 후 수업 soft delete [매니저 이상]' })
  remove(@Param('id', PositiveIntPipe) id: number, @Req() req: Request & { user?: JwtClaims }) {
    return this.courses.remove(id, req.user?.sub);
  }
}
