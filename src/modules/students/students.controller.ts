import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import type { JwtClaims } from '../auth/auth.service';
import { StudentsService } from './students.service';
import { RolesGuard } from '../auth/roles.guard';
import { Roles, ADMIN_ROLES, STAFF_ROLES } from '../auth/roles.decorator';
import { CreateStudentFamilyRelationDto, UpdateStudentFamilyRelationDto } from './dto/student-family-relation.dto';
import { CreateStudentAcademicHistoryDto, UpdateStudentAcademicHistoryDto } from './dto/student-academic-history.dto';
import { ApiOperation, ApiTags } from '@nestjs/swagger';

@ApiTags('students')
@UseGuards(RolesGuard)
@Controller('students')
export class StudentsController {
  constructor(private readonly students: StudentsService) {}

  @Get()
  @Roles(...STAFF_ROLES) // [보안 2026-07-03] 사내 데이터 조회 — 로그인 필수
  @ApiOperation({ summary: '학생 원부 목록 조회(soft delete 제외, 퇴원·등록이탈 포함) [전 직원]' })
  findAll() {
    return this.students.listDb(); // [TBO-54 C2] DB 권위 READ
  }

  @Get(':id/family-relations')
  @Roles(...ADMIN_ROLES)
  @ApiOperation({ summary: '학생의 등록 가족 관계 목록 조회 [매니저 이상]' })
  findFamilyRelations(@Param('id', ParseIntPipe) id: number) {
    return this.students.findFamilyRelationsDb(id); // [TBO-56 C2b] DB 권위 READ
  }

  // [TBO-30G 2026-07-23] 가족 조인 단일 진실원 — 관계→학생→보호자→수강→상담 서버 조인 파생(읽기 전용).
  @Get(':id/family')
  @Roles(...ADMIN_ROLES)
  @ApiOperation({ summary: '가족(형제·자매) 조인 aggregate — 구성원별 학생·보호자·활성 수강·상담 이력·공유 보호자(테이블 조인 파생, 단일 진실원) [매니저 이상]' })
  findFamilyAggregate(@Param('id', ParseIntPipe) id: number) {
    return this.students.findFamilyAggregateDb(id); // [TBO-56 C2b] 재수화 후 조인(교차 인스턴스 즉시)
  }

  @Post(':id/family-relations')
  @Roles(...ADMIN_ROLES)
  @ApiOperation({ summary: '학생과 기존 학생의 가족 관계 생성 및 이력 기록 [매니저 이상]' })
  createFamilyRelation(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: CreateStudentFamilyRelationDto,
    @Req() req: Request & { user?: JwtClaims },
  ) {
    return this.students.createFamilyRelation(id, dto, req.user!.sub);
  }

  @Patch(':id/family-relations/:relationId')
  @Roles(...ADMIN_ROLES)
  @ApiOperation({ summary: '학생 가족 관계 수정 및 이력 기록 [매니저 이상]' })
  updateFamilyRelation(
    @Param('id', ParseIntPipe) id: number,
    @Param('relationId', ParseIntPipe) relationId: number,
    @Body() dto: UpdateStudentFamilyRelationDto,
    @Req() req: Request & { user?: JwtClaims },
  ) {
    return this.students.updateFamilyRelation(id, relationId, dto, req.user!.sub);
  }

  @Delete(':id/family-relations/:relationId')
  @Roles(...ADMIN_ROLES)
  @ApiOperation({ summary: '학생 가족 관계 soft delete 및 이력 기록 [매니저 이상]' })
  removeFamilyRelation(
    @Param('id', ParseIntPipe) id: number,
    @Param('relationId', ParseIntPipe) relationId: number,
    @Req() req: Request & { user?: JwtClaims },
  ) {
    return this.students.removeFamilyRelation(id, relationId, req.user!.sub);
  }

  @Get(':id/academic-histories')
  @Roles(...ADMIN_ROLES)
  @ApiOperation({ summary: '학생 학교·학년 변경 timeline 조회 [매니저 이상]' })
  findAcademicHistories(@Param('id', ParseIntPipe) id: number) {
    return this.students.findAcademicHistoriesDb(id); // [TBO-56 C2b] DB 권위 READ
  }

  @Post(':id/academic-histories')
  @Roles(...ADMIN_ROLES)
  @ApiOperation({ summary: '학생 학교·학년 이력 생성 [매니저 이상]' })
  createAcademicHistory(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: CreateStudentAcademicHistoryDto,
    @Req() req: Request & { user?: JwtClaims },
  ) {
    return this.students.createAcademicHistory(id, dto, req.user!.sub);
  }

  @Patch(':id/academic-histories/:historyId')
  @Roles(...ADMIN_ROLES)
  @ApiOperation({ summary: '학생 학교·학년 이력 수정 [매니저 이상]' })
  updateAcademicHistory(
    @Param('id', ParseIntPipe) id: number,
    @Param('historyId', ParseIntPipe) historyId: number,
    @Body() dto: UpdateStudentAcademicHistoryDto,
    @Req() req: Request & { user?: JwtClaims },
  ) {
    return this.students.updateAcademicHistory(id, historyId, dto, req.user!.sub);
  }

  @Delete(':id/academic-histories/:historyId')
  @Roles(...ADMIN_ROLES)
  @ApiOperation({ summary: '학생 학교·학년 이력 soft delete [매니저 이상]' })
  removeAcademicHistory(
    @Param('id', ParseIntPipe) id: number,
    @Param('historyId', ParseIntPipe) historyId: number,
    @Req() req: Request & { user?: JwtClaims },
  ) {
    return this.students.removeAcademicHistory(id, historyId, req.user!.sub);
  }

  @Get(':id')
  @Roles(...STAFF_ROLES) // [보안 2026-07-03] 사내 데이터 조회 — 로그인 필수
  @ApiOperation({ summary: '학생 단건 프로필 조회 [전 직원]' })
  findOne(@Param('id', ParseIntPipe) id: number) {
    return this.students.getDb(id); // [TBO-54 C2] DB 권위 READ
  }

  @Delete(':id')
  @Roles(...ADMIN_ROLES)
  @ApiOperation({ summary: '학생 soft delete 및 관련 활성 관계 정리 [매니저 이상]' })
  remove(@Param('id', ParseIntPipe) id: number, @Req() req: Request & { user?: JwtClaims }) {
    return this.students.remove(id, req.user?.sub);
  }
}
