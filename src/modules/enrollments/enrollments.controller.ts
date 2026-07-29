import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { OptionalPositiveIntPipe, PositiveIntPipe } from '../../common/positive-int.pipe';
import type { Request } from 'express';
import { EnrollmentsService } from './enrollments.service';
import { CreateEnrollmentDto } from './dto/create-enrollment.dto';
import { UpdateEnrollmentDto } from './dto/update-enrollment.dto';
import { RolesGuard } from '../auth/roles.guard';
import { Roles, ADMIN_ROLES, STAFF_ROLES } from '../auth/roles.decorator';
import type { JwtClaims } from '../auth/auth.service';
import { ApiOperation, ApiTags } from '@nestjs/swagger';

@ApiTags('enrollments')
@UseGuards(RolesGuard)
@Controller('enrollments')
export class EnrollmentsController {
  constructor(private readonly enrollments: EnrollmentsService) {}

  @Get()
  @Roles(...STAFF_ROLES) // [보안 2026-07-03] 사내 데이터 조회 — 로그인 필수
  @ApiOperation({ summary: '수강 등록 목록 조회, studentId 선택 필터 [전 직원]' })
  findAll(
    @Query('studentId', OptionalPositiveIntPipe) studentId?: number,
  ) {
    if (studentId !== undefined) return this.enrollments.listDb(studentId); // [TBO-54 C2] DB 권위 READ
    return this.enrollments.listDb();
  }

  @Get(':id')
  @Roles(...STAFF_ROLES) // [보안 2026-07-03] 사내 데이터 조회 — 로그인 필수
  @ApiOperation({ summary: '수강 등록 단건 조회 [전 직원]' })
  findOne(@Param('id', PositiveIntPipe) id: number) {
    return this.enrollments.getDb(id); // [TBO-54 C2] DB 권위 READ
  }

  @Post()
  @Roles(...ADMIN_ROLES)
  @ApiOperation({ summary: '학생과 수업을 연결하는 수강 등록 생성 [매니저 이상]' })
  create(@Body() dto: CreateEnrollmentDto, @Req() req: Request & { user?: JwtClaims }) {
    return this.enrollments.create(dto, req.user?.sub);
  }

  @Patch(':id')
  @Roles(...ADMIN_ROLES)
  @ApiOperation({ summary: '수강 상태·기간·회차·메모 변경 및 감사 이력 기록 [매니저 이상]' })
  update(
    @Param('id', PositiveIntPipe) id: number,
    @Body() dto: UpdateEnrollmentDto,
    @Req() req: Request & { user?: JwtClaims },
  ) {
    return this.enrollments.update(id, dto, req.user!.sub);
  }
}
