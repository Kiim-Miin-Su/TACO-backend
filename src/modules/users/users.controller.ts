import { BadRequestException, Body, Controller, Get, Patch, Post, Query, Req, UnauthorizedException, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation } from '@nestjs/swagger';
import type { Request } from 'express';
import { UsersService } from './users.service';
import { RolesGuard } from '../auth/roles.guard';
import { ADMIN_ROLES, Roles, STAFF_ROLES } from '../auth/roles.decorator';
import { SuperAdminGuard } from '../auth/super-admin.guard';
import { CreateInstructorDto } from './dto/create-instructor.dto';
import type { JwtClaims } from '../auth/auth.service';
import { ChangeCredentialsDto } from './dto/change-credentials.dto';
import { CredentialAccountResponseDto } from './dto/credential-account-response.dto';
import { ProfileResponseDto } from './dto/profile-response.dto';
import { profileVersionOf } from './user.entity';

@UseGuards(RolesGuard)
@Controller('users')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get('me/profile')
  @Roles(...STAFF_ROLES)
  @ApiBearerAuth()
  @ApiOperation({ summary: '내 프로필 조회. [전 직원]' })
  @ApiOkResponse({ type: ProfileResponseDto })
  async profile(@Req() req: Request & { user?: JwtClaims }): Promise<ProfileResponseDto> {
    const sub = req.user?.sub;
    if (typeof sub !== 'number') throw new UnauthorizedException('인증 정보가 없습니다.');
    await this.users.refreshFromDb();
    const account = this.users.findById(sub);
    if (!account) throw new UnauthorizedException('계정 정보를 확인할 수 없습니다.');
    return {
      id: account.id,
      webId: account.webId,
      name: account.name,
      email: account.email,
      phone: account.phone,
      countryCode: account.countryCode,
      timeZone: account.timeZone,
      role: account.role,
      status: account.status,
      profileVersion: profileVersionOf(account),
    };
  }

  // [운영 흐름 2026-07-14] 대표 직접 강사 등록 — 즉시 active(계정+프로필+audit 단일 tx).
  @Post('instructors')
  @UseGuards(SuperAdminGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: '강사 직접 등록(대표 전용) — 즉시 active, users+instructor_profiles+audit 원자 tx.' })
  async createInstructor(@Body() dto: CreateInstructorDto, @Req() req: Request & { user?: JwtClaims }) {
    const sub = req.user?.sub;
    if (typeof sub !== 'number') throw new UnauthorizedException('인증 정보가 없습니다.');
    return this.users.provisionInstructor(dto, sub);
  }

  @Patch('me/credentials')
  @Roles(...STAFF_ROLES)
  @ApiBearerAuth()
  @ApiOperation({ summary: '내 아이디/비밀번호 변경 — 현재 비밀번호 재검증, auth_version 증가, audit 원자 tx.' })
  @ApiOkResponse({ type: CredentialAccountResponseDto })
  async changeCredentials(@Body() dto: ChangeCredentialsDto, @Req() req: Request & { user?: JwtClaims }) {
    const sub = req.user?.sub;
    if (typeof sub !== 'number') throw new UnauthorizedException('인증 정보가 없습니다.');
    const account = await this.users.changeCredentials(sub, dto);
    return {
      id: account.id,
      webId: account.webId,
      name: account.name,
      role: account.role,
      mustChangePassword: account.mustChangePassword === true,
    };
  }

  // 학생/학부모 web id 존재 확인 (등록 폼 "확인하기" — 스태프 앱 내부에서만 호출)
  @Get('exists')
  @Roles(...STAFF_ROLES) // [코드리뷰 2026-07-03 H2] @Roles 누락 → 무인증 webId 열거 가능했음. 스태프 로그인 필수
  async exists(@Query('webId') webId?: string) {
    if (!webId?.trim()) throw new BadRequestException('webId required');
    await this.users.refreshFromDb(); // [28F]
    return this.users.checkWebId(webId);
  }

  @Get()
  @Roles(...ADMIN_ROLES) // 직원 이메일·승인 metadata·마지막 로그인 포함 — 관리자만
  async list() {
    await this.users.refreshFromDb(); // [28F]
    return this.users.findAll();
  }
}
