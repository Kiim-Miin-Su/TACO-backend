import { Body, Controller, Delete, Get, Param, ParseIntPipe, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { RolesGuard } from '../auth/roles.guard';
import { ADMIN_ROLES, Roles, STAFF_ROLES } from '../auth/roles.decorator';
import type { JwtClaims } from '../auth/auth.service';
import { RoadmapsService } from './roadmaps.service';
import { AddRoadmapCourseDto, CreateRoadmapDto, ReorderRoadmapCoursesDto, UpdateRoadmapDto } from './dto/roadmap.dto';

// [TBO-47 2026-07-23] 수강 로드맵 — 코스 묶음 카탈로그(조회 전 직원·쓰기 매니저 이상).
@ApiTags('roadmaps')
@ApiBearerAuth()
@UseGuards(RolesGuard)
@Controller('roadmaps')
export class RoadmapsController {
  constructor(private readonly roadmaps: RoadmapsService) {}

  private actorOf(req: Request & { user?: JwtClaims }): number {
    return req.user!.sub;
  }

  @Get()
  @Roles(...STAFF_ROLES)
  @ApiOperation({ summary: '로드맵 목록(코스 조인 aggregate — sortOrder 정렬) [전 직원]' })
  findAll() {
    return this.roadmaps.findAll();
  }

  @Get(':id')
  @Roles(...STAFF_ROLES)
  @ApiOperation({ summary: '로드맵 단건(코스 조인 aggregate). 없는 id=404. [전 직원]' })
  findOne(@Param('id', ParseIntPipe) id: number) {
    return this.roadmaps.findOne(id);
  }

  @Post()
  @Roles(...ADMIN_ROLES)
  @ApiOperation({ summary: '로드맵 생성 — courseIds 순서대로 일괄 연결(한 tx)·audit [매니저 이상]' })
  create(@Body() dto: CreateRoadmapDto, @Req() req: Request & { user?: JwtClaims }) {
    return this.roadmaps.create(dto, this.actorOf(req));
  }

  @Patch(':id')
  @Roles(...ADMIN_ROLES)
  @ApiOperation({ summary: '로드맵 수정(제목·설명·대상 학년·기간·활성) — audit diff [매니저 이상]' })
  update(@Param('id', ParseIntPipe) id: number, @Body() dto: UpdateRoadmapDto, @Req() req: Request & { user?: JwtClaims }) {
    return this.roadmaps.update(id, dto, this.actorOf(req));
  }

  @Delete(':id')
  @Roles(...ADMIN_ROLES)
  @ApiOperation({ summary: '로드맵 soft delete — 연결 코스 링크 캐스케이드(한 tx)·audit [매니저 이상]' })
  remove(@Param('id', ParseIntPipe) id: number, @Req() req: Request & { user?: JwtClaims }) {
    return this.roadmaps.remove(id, this.actorOf(req));
  }

  @Post(':id/courses')
  @Roles(...ADMIN_ROLES)
  @ApiOperation({ summary: '로드맵에 코스 연결(말단 순서) — 중복 409·없는 코스 400 [매니저 이상]' })
  addCourse(@Param('id', ParseIntPipe) id: number, @Body() dto: AddRoadmapCourseDto, @Req() req: Request & { user?: JwtClaims }) {
    return this.roadmaps.addCourse(id, dto.courseId, this.actorOf(req));
  }

  @Delete(':id/courses/:courseId')
  @Roles(...ADMIN_ROLES)
  @ApiOperation({ summary: '로드맵 코스 연결 해제 — 잔여 sortOrder 연속 재정렬 [매니저 이상]' })
  removeCourse(
    @Param('id', ParseIntPipe) id: number,
    @Param('courseId', ParseIntPipe) courseId: number,
    @Req() req: Request & { user?: JwtClaims },
  ) {
    return this.roadmaps.removeCourse(id, courseId, this.actorOf(req));
  }

  @Patch(':id/courses/reorder')
  @Roles(...ADMIN_ROLES)
  @ApiOperation({ summary: '로드맵 코스 전체 재정렬 — 부분 목록 400(조용한 누락 금지) [매니저 이상]' })
  reorder(@Param('id', ParseIntPipe) id: number, @Body() dto: ReorderRoadmapCoursesDto, @Req() req: Request & { user?: JwtClaims }) {
    return this.roadmaps.reorderCourses(id, dto.courseIds, this.actorOf(req));
  }
}
