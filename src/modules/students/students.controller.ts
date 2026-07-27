import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { PositiveIntPipe } from '../../common/positive-int.pipe';
import type { Request } from 'express';
import type { JwtClaims } from '../auth/auth.service';
import { StudentsService } from './students.service';
import { RolesGuard } from '../auth/roles.guard';
import { SudoGuard } from '../auth/sudo.guard'; // [TBO-59 C3-2] 파괴 명령 재인증
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
  @ApiOperation({ summary: '학생 원부 목록 — 관리자 전체 / 강사는 담당 학생만+안전 필드(P0-5) [전 직원]' })
  findAll(@Req() req: Request & { user?: JwtClaims }) {
    // [TBO-59 C3] 강사 = 본인 담당 코스 수강생·세션 참여 학생만, PII 필드 제거(allowlist)
    return this.students.listDbForActor(req.user?.sub, req.user?.roles ?? []);
  }

  @Get(':id/family-relations')
  @Roles(...ADMIN_ROLES)
  @ApiOperation({ summary: '학생의 등록 가족 관계 목록 조회 [매니저 이상]' })
  findFamilyRelations(@Param('id', PositiveIntPipe) id: number) {
    return this.students.findFamilyRelationsDb(id); // [TBO-56 C2b] DB 권위 READ
  }

  // [TBO-30G 2026-07-23] 가족 조인 단일 진실원 — 관계→학생→보호자→수강→상담 서버 조인 파생(읽기 전용).
  @Get(':id/family')
  @Roles(...ADMIN_ROLES)
  @ApiOperation({ summary: '가족(형제·자매) 조인 aggregate — 구성원별 학생·보호자·활성 수강·상담 이력·공유 보호자(테이블 조인 파생, 단일 진실원) [매니저 이상]' })
  findFamilyAggregate(@Param('id', PositiveIntPipe) id: number) {
    return this.students.findFamilyAggregateDb(id); // [TBO-56 C2b] 재수화 후 조인(교차 인스턴스 즉시)
  }

  @Post(':id/family-relations')
  @Roles(...ADMIN_ROLES)
  @ApiOperation({ summary: '학생과 기존 학생의 가족 관계 생성 및 이력 기록 [매니저 이상]' })
  createFamilyRelation(
    @Param('id', PositiveIntPipe) id: number,
    @Body() dto: CreateStudentFamilyRelationDto,
    @Req() req: Request & { user?: JwtClaims },
  ) {
    return this.students.createFamilyRelation(id, dto, req.user!.sub);
  }

  @Patch(':id/family-relations/:relationId')
  @Roles(...ADMIN_ROLES)
  @ApiOperation({ summary: '학생 가족 관계 수정 및 이력 기록 [매니저 이상]' })
  updateFamilyRelation(
    @Param('id', PositiveIntPipe) id: number,
    @Param('relationId', PositiveIntPipe) relationId: number,
    @Body() dto: UpdateStudentFamilyRelationDto,
    @Req() req: Request & { user?: JwtClaims },
  ) {
    return this.students.updateFamilyRelation(id, relationId, dto, req.user!.sub);
  }

  @Delete(':id/family-relations/:relationId')
  @Roles(...ADMIN_ROLES)
  @ApiOperation({ summary: '학생 가족 관계 soft delete 및 이력 기록 [매니저 이상]' })
  removeFamilyRelation(
    @Param('id', PositiveIntPipe) id: number,
    @Param('relationId', PositiveIntPipe) relationId: number,
    @Req() req: Request & { user?: JwtClaims },
  ) {
    return this.students.removeFamilyRelation(id, relationId, req.user!.sub);
  }

  @Get(':id/academic-histories')
  @Roles(...ADMIN_ROLES)
  @ApiOperation({ summary: '학생 학교·학년 변경 timeline 조회 [매니저 이상]' })
  findAcademicHistories(@Param('id', PositiveIntPipe) id: number) {
    return this.students.findAcademicHistoriesDb(id); // [TBO-56 C2b] DB 권위 READ
  }

  @Post(':id/academic-histories')
  @Roles(...ADMIN_ROLES)
  @ApiOperation({ summary: '학생 학교·학년 이력 생성 [매니저 이상]' })
  createAcademicHistory(
    @Param('id', PositiveIntPipe) id: number,
    @Body() dto: CreateStudentAcademicHistoryDto,
    @Req() req: Request & { user?: JwtClaims },
  ) {
    return this.students.createAcademicHistory(id, dto, req.user!.sub);
  }

  @Patch(':id/academic-histories/:historyId')
  @Roles(...ADMIN_ROLES)
  @ApiOperation({ summary: '학생 학교·학년 이력 수정 [매니저 이상]' })
  updateAcademicHistory(
    @Param('id', PositiveIntPipe) id: number,
    @Param('historyId', PositiveIntPipe) historyId: number,
    @Body() dto: UpdateStudentAcademicHistoryDto,
    @Req() req: Request & { user?: JwtClaims },
  ) {
    return this.students.updateAcademicHistory(id, historyId, dto, req.user!.sub);
  }

  @Delete(':id/academic-histories/:historyId')
  @Roles(...ADMIN_ROLES)
  @ApiOperation({ summary: '학생 학교·학년 이력 soft delete [매니저 이상]' })
  removeAcademicHistory(
    @Param('id', PositiveIntPipe) id: number,
    @Param('historyId', PositiveIntPipe) historyId: number,
    @Req() req: Request & { user?: JwtClaims },
  ) {
    return this.students.removeAcademicHistory(id, historyId, req.user!.sub);
  }

  @Get(':id')
  @Roles(...STAFF_ROLES) // [보안 2026-07-03] 사내 데이터 조회 — 로그인 필수
  @ApiOperation({ summary: '학생 단건 — 관리자 full / 강사는 담당 학생만+안전 필드, 밖은 403(P0-5) [전 직원]' })
  findOne(@Param('id', PositiveIntPipe) id: number, @Req() req: Request & { user?: JwtClaims }) {
    return this.students.getDbForActor(id, req.user?.sub, req.user?.roles ?? []); // [TBO-59 C3]
  }

  @Delete(':id')
  @UseGuards(SudoGuard) // [TBO-59 C3-2] 원부 삭제 = sudo 재인증(브라우저 cookie 경로 강제)
  @Roles(...ADMIN_ROLES)
  @ApiOperation({ summary: '학생 soft delete 및 관련 활성 관계 정리(재인증 필수) [매니저 이상]. cookie 세션은 reauth 후 10분 내만 허용(403 SUDO_REQUIRED).' })
  remove(@Param('id', PositiveIntPipe) id: number, @Req() req: Request & { user?: JwtClaims }) {
    return this.students.remove(id, req.user?.sub);
  }
}
