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

@UseGuards(RolesGuard)
@Controller('students')
export class StudentsController {
  constructor(private readonly students: StudentsService) {}

  @Get()
  @Roles(...STAFF_ROLES) // [보안 2026-07-03] 사내 데이터 조회 — 로그인 필수
  findAll() {
    return this.students.findAll();
  }

  @Get(':id/family-relations')
  @Roles(...ADMIN_ROLES)
  findFamilyRelations(@Param('id', ParseIntPipe) id: number) {
    return this.students.findFamilyRelations(id);
  }

  @Post(':id/family-relations')
  @Roles(...ADMIN_ROLES)
  createFamilyRelation(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: CreateStudentFamilyRelationDto,
    @Req() req: Request & { user?: JwtClaims },
  ) {
    return this.students.createFamilyRelation(id, dto, req.user!.sub);
  }

  @Patch(':id/family-relations/:relationId')
  @Roles(...ADMIN_ROLES)
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
  removeFamilyRelation(
    @Param('id', ParseIntPipe) id: number,
    @Param('relationId', ParseIntPipe) relationId: number,
    @Req() req: Request & { user?: JwtClaims },
  ) {
    return this.students.removeFamilyRelation(id, relationId, req.user!.sub);
  }

  @Get(':id/academic-histories')
  @Roles(...ADMIN_ROLES)
  findAcademicHistories(@Param('id', ParseIntPipe) id: number) {
    return this.students.findAcademicHistories(id);
  }

  @Post(':id/academic-histories')
  @Roles(...ADMIN_ROLES)
  createAcademicHistory(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: CreateStudentAcademicHistoryDto,
    @Req() req: Request & { user?: JwtClaims },
  ) {
    return this.students.createAcademicHistory(id, dto, req.user!.sub);
  }

  @Patch(':id/academic-histories/:historyId')
  @Roles(...ADMIN_ROLES)
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
  removeAcademicHistory(
    @Param('id', ParseIntPipe) id: number,
    @Param('historyId', ParseIntPipe) historyId: number,
    @Req() req: Request & { user?: JwtClaims },
  ) {
    return this.students.removeAcademicHistory(id, historyId, req.user!.sub);
  }

  @Get(':id')
  @Roles(...STAFF_ROLES) // [보안 2026-07-03] 사내 데이터 조회 — 로그인 필수
  findOne(@Param('id', ParseIntPipe) id: number) {
    return this.students.findOne(id);
  }

  @Delete(':id')
  @Roles(...ADMIN_ROLES)
  remove(@Param('id', ParseIntPipe) id: number, @Req() req: Request & { user?: JwtClaims }) {
    return this.students.remove(id, req.user?.sub);
  }
}
