import { Body, Controller, Post, Req, UnauthorizedException, UseGuards } from '@nestjs/common';
import { ApiCreatedResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { RolesGuard } from '../auth/roles.guard';
import { Roles, ADMIN_ROLES } from '../auth/roles.decorator';
import type { JwtClaims } from '../auth/auth.service';
import { RegistrationsService } from './registrations.service';
import { RegisterStudentDto } from './dto/register-student.dto';

// [TBO-29D D2] POST /students/registrations — 학생+보호자+수강 원자 등록(부분 저장 불가).
//  students prefix를 공유하지만 순환 의존 회피를 위해 별도 모듈/컨트롤러다.
@ApiTags('students')
@UseGuards(RolesGuard)
@Controller('students')
export class RegistrationsController {
  constructor(private readonly registrations: RegistrationsService) {}

  @Post('registrations')
  @Roles(...ADMIN_ROLES)
  @ApiOperation({ summary: '학생 원자 등록 — student+guardian(선택)+enrollment(선택)+audit 단일 tx. 중간 실패 시 전부 +0.' })
  @ApiCreatedResponse({ description: '{ student, guardian: { parent, relation, linkedExisting } | null, enrollment | null }' })
  register(@Body() dto: RegisterStudentDto, @Req() req: Request & { user?: JwtClaims }) {
    const sub = req.user?.sub;
    if (typeof sub !== 'number') throw new UnauthorizedException('인증 정보가 없습니다.');
    return this.registrations.register(dto, sub);
  }
}
