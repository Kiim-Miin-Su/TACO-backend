import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiOkResponse, ApiCreatedResponse } from '@nestjs/swagger';
import { RoadmapsService } from './roadmaps.service';
import { CreateRoadmapDto } from './dto/create-roadmap.dto';
import { RolesGuard } from '../auth/roles.guard';
import { Roles, ADMIN_ROLES, STAFF_ROLES } from '../auth/roles.decorator';

// [참조/처리] /api/roadmaps REST(카탈로그 — courses/subjects와 동일하게 무가드).
//  - GET /roadmaps: 로드맵 목록. GET /roadmaps/courses: M:N 링크 목록(프론트가 두 배열로 하이드레이트).
//  - POST /roadmaps: courseIds FK 검증 후 로드맵+링크 생성.
@ApiTags('roadmaps')
@UseGuards(RolesGuard)
@Controller('roadmaps')
export class RoadmapsController {
  constructor(private readonly roadmaps: RoadmapsService) {}

  @Get()
  @Roles(...STAFF_ROLES) // [보안 2026-07-03] 사내 데이터 조회 — 로그인 필수
  @ApiOperation({ summary: '로드맵 목록(Roadmap[])' })
  @ApiOkResponse({ description: 'Roadmap[] — title·targetGrade·durationWeeks·isActive' })
  findAll() {
    return this.roadmaps.findAll();
  }

  @Get('courses')
  @Roles(...STAFF_ROLES) // [보안 2026-07-03] 사내 데이터 조회 — 로그인 필수
  @ApiOperation({ summary: '로드맵↔코스 링크(RoadmapCourse[]) — M:N 조인(sortOrder)' })
  @ApiOkResponse({ description: 'RoadmapCourse[] — roadmapId·courseId·sortOrder' })
  findAllCourses() {
    return this.roadmaps.findAllCourses();
  }

  @Post()
  @Roles(...ADMIN_ROLES)
  @ApiOperation({ summary: '로드맵 생성 — courseIds(코스 FK) 순서대로 링크' })
  @ApiCreatedResponse({ description: '생성된 Roadmap' })
  create(@Body() dto: CreateRoadmapDto) {
    return this.roadmaps.create(dto);
  }
}
