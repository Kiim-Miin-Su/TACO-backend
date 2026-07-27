import { Body, Controller, Get, Param, Patch, Post, Req, UnauthorizedException, UseGuards } from '@nestjs/common';
import { PositiveIntPipe } from '../../common/positive-int.pipe';
import { ApiCreatedResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { RolesGuard } from '../auth/roles.guard';
import { Roles, ADMIN_ROLES, STAFF_ROLES, isInstructorOnly } from '../auth/roles.decorator';
import type { JwtClaims } from '../auth/auth.service';
import { RegistrationsService } from './registrations.service';
import { RegisterStudentDto } from './dto/register-student.dto';
import { UpdateStudentAggregateDto } from '../students/dto/update-student-aggregate.dto';
import { UpdateStudentDto } from '../students/dto/update-student.dto';

// [TBO-29D D2] POST /students/registrations — 학생+보호자+수강 원자 등록(부분 저장 불가).
//  students prefix를 공유하지만 순환 의존 회피를 위해 별도 모듈/컨트롤러다.
@ApiTags('students')
@UseGuards(RolesGuard)
@Controller('students')
export class RegistrationsController {
  constructor(private readonly registrations: RegistrationsService) {}

  @Post()
  @Roles(...ADMIN_ROLES)
  @ApiOperation({ summary: '학생 aggregate 생성 — /students/registrations와 동일한 원자 command' })
  create(@Body() dto: RegisterStudentDto, @Req() req: Request & { user?: JwtClaims }) {
    return this.register(dto, req);
  }

  @Post('registrations')
  @Roles(...ADMIN_ROLES)
  @ApiOperation({ summary: '학생 원자 등록 — student+guardian(선택)+enrollment(선택)+audit 단일 tx. 중간 실패 시 전부 +0.' })
  @ApiCreatedResponse({ description: '{ student, guardian: { parent, relation, linkedExisting } | null, enrollment | null }' })
  register(@Body() dto: RegisterStudentDto, @Req() req: Request & { user?: JwtClaims }) {
    const sub = req.user?.sub;
    if (typeof sub !== 'number') throw new UnauthorizedException('인증 정보가 없습니다.');
    return this.registrations.register(dto, sub);
  }

  @Get(':id/aggregate')
  @Roles(...STAFF_ROLES)
  @ApiOperation({ summary: '학생 프로필·희망 수업·보호자·수강·학사 이력 aggregate 조회 [역할별 최소화]' })
  async getAggregate(@Param('id', PositiveIntPipe) id: number, @Req() req: Request & { user?: JwtClaims }) {
    const aggregate = await this.registrations.getAggregate(id); // [TBO-54 C2] DB 권위 READ
    if (!isInstructorOnly(req.user?.roles)) return aggregate;
    const { student, interests, guardians } = aggregate;
    return { student, interests, guardians };
  }

  @Patch(':id/aggregate')
  @Roles(...ADMIN_ROLES)
  @ApiOperation({ summary: '학생 프로필·희망 수업·보호자 aggregate 원자 수정 [매니저 이상]' })
  updateAggregate(
    @Param('id', PositiveIntPipe) id: number,
    @Body() dto: UpdateStudentAggregateDto,
    @Req() req: Request & { user?: JwtClaims },
  ) {
    const sub = req.user?.sub;
    if (typeof sub !== 'number') throw new UnauthorizedException('인증 정보가 없습니다.');
    return this.registrations.updateAggregate(id, dto, sub);
  }

  @Patch(':id')
  @Roles(...ADMIN_ROLES)
  @ApiOperation({ summary: '학생 기본 프로필 수정 및 audit 기록 [매니저 이상]' })
  updateStudent(
    @Param('id', PositiveIntPipe) id: number,
    @Body() student: UpdateStudentDto,
    @Req() req: Request & { user?: JwtClaims },
  ) {
    const sub = req.user?.sub;
    if (typeof sub !== 'number') throw new UnauthorizedException('인증 정보가 없습니다.');
    return this.registrations.updateAggregate(id, { student }, sub).then((aggregate) => aggregate.student);
  }
}
