import { BadRequestException, Body, Controller, Delete, ForbiddenException, Get, Param, Patch, Post, Put, Query, Req, UnauthorizedException, UseGuards } from '@nestjs/common';
import { PositiveIntPipe } from '../../common/positive-int.pipe';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiParam, ApiQuery } from '@nestjs/swagger';
import type { Request } from 'express';
import { UsersService } from './users.service';
import { SignupApprovalService } from './signup-approval.service'; // [TBO-68 C3] 직접 등록
import { RolesGuard } from '../auth/roles.guard';
import {
  ADMIN_ROLES,
  RequireCapabilities,
  Roles,
  STAFF_ROLES,
  claimsHaveCapability,
} from '../auth/roles.decorator';
import { SudoGuard } from '../auth/sudo.guard'; // [TBO-34 C2-C] 재인증 서버측 강제(리뷰 보안 ①)
import { CreateInstructorDto } from './dto/create-instructor.dto';
import { AdminUpdateUserDto } from './dto/admin-update-user.dto';
import type { JwtClaims } from '../auth/auth.service';
import { ProfileResponseDto } from './dto/profile-response.dto';
import { smsChallengeAvailable } from '../profile-verifications/sms-availability';
import { profileVersionOf } from './user.entity';
import { UserLifecycleDto } from './dto/user-lifecycle.dto';
import { StaffAccountResponseDto } from './dto/staff-account-response.dto';
import { AccessControlService } from '../auth/access-control.service';
import { SetUserCapabilityDto } from '../auth/dto/set-user-capability.dto';

@UseGuards(RolesGuard)
@Controller('users')
export class UsersController {
  constructor(
    private readonly users: UsersService,
    private readonly signupApproval: SignupApprovalService, // [TBO-68 C3]
    private readonly access: AccessControlService,
  ) {}

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
      // [TBO-31 C1 D5] 이메일 인증 상태 노출 — 마이페이지 배지·미인증 안내(RRN은 어떤 형태로도 미노출)
      emailVerified: account.emailVerified === true,
      profileVersion: profileVersionOf(account),
      // [2026-07-16] SENS env 투입 시 FE phone 인증 스테퍼 자동 활성(단일 판정 소스 공유)
      smsVerificationAvailable: smsChallengeAvailable(),
    };
  }

  // [운영 흐름 2026-07-14] 대표 직접 강사 등록 — 즉시 active(계정+프로필+audit 단일 tx).
  @Post('instructors')
  @UseGuards(SudoGuard)
  @RequireCapabilities('executive.manage')
  @ApiBearerAuth()
  @ApiOperation({ summary: '강사 직접 등록(대표 전용·재인증 필수) — 즉시 active, users+instructor_profiles+audit 원자 tx. cookie 세션은 reauth 후 10분 내만 허용(403 SUDO_REQUIRED).' })
  async createInstructor(@Body() dto: CreateInstructorDto, @Req() req: Request & { user?: JwtClaims }) {
    const sub = req.user?.sub;
    if (typeof sub !== 'number') throw new UnauthorizedException('인증 정보가 없습니다.');
    return this.signupApproval.provisionInstructor(dto, sub);
  }

  // [E0] PATCH me/credentials는 CredentialsModule로 이동(비밀번호 변경 이메일 OTP 오케스트레이션 —
  //  Users↔ProfileVerifications 모듈 순환 회피). 경로·계약은 동일.

  // 학생/학부모 web id 존재 확인 (등록 폼 "확인하기" — 스태프 앱 내부에서만 호출)
  @Get('exists')
  @Roles(...STAFF_ROLES) // [코드리뷰 2026-07-03 H2] @Roles 누락 → 무인증 webId 열거 가능했음. 스태프 로그인 필수
  @ApiOperation({ summary: '학생·보호자 연결용 Web ID 존재 여부 확인 [전 직원]' })
  async exists(@Query('webId') webId?: string) {
    if (!webId?.trim()) throw new BadRequestException('webId required');
    await this.users.refreshFromDb(); // [28F]
    return this.users.checkWebId(webId);
  }

  @Get()
  @Roles(...ADMIN_ROLES) // 직원 이메일·승인 metadata·마지막 로그인 포함 — 관리자만
  @ApiOperation({ summary: '직원 계정 목록과 승인 상태 조회 [매니저 이상]' })
  @ApiQuery({ name: 'includeTerminated', required: false, type: Boolean })
  @ApiOkResponse({ type: StaffAccountResponseDto, isArray: true })
  async list(
    @Query('includeTerminated') includeTerminated: string | undefined,
    @Req() req: Request & { user?: JwtClaims },
  ) {
    await this.users.refreshFromDb(); // [28F]
    const include = includeTerminated === 'true';
    if (include && !claimsHaveCapability(req.user?.roles ?? [], 'executive.manage')) {
      throw new ForbiddenException('종료 계정 조회는 대표 권한이 필요합니다.');
    }
    return this.users.findAll(include);
  }

  // ── [유저 관리 2026-07-20 대표 지시] 상세 단건 + 대표 직접 수정 ──
  //  ⚠ 'exists'보다 뒤·숫자 경로 — PositiveIntPipe가 비숫자를 400으로 거른다.
  @Get(':id')
  @Roles(...ADMIN_ROLES)
  @ApiBearerAuth()
  @ApiOperation({ summary: '계정 상세(관리자) — super_admin에게만 rrnMasked 동봉.' })
  @ApiOkResponse({ type: StaffAccountResponseDto })
  async detail(@Param('id', PositiveIntPipe) id: number, @Req() req: Request & { user?: JwtClaims }) {
    const roles = req.user?.roles ?? [];
    return this.users.getUserDetail(
      id,
      claimsHaveCapability(roles, 'executive.manage') ? 'super_admin' : 'admin',
    );
  }

  @Get(':id/permissions')
  @RequireCapabilities('access.manage')
  @ApiBearerAuth()
  @ApiOperation({ summary: '사용자 유효 권한 projection — 역할 기본값+DB 개별 예외 [대표·관리자]' })
  permissions(@Param('id', PositiveIntPipe) id: number, @Req() req: Request & { user?: JwtClaims }) {
    return this.access.permissionsFor(id, req.user!.sub);
  }

  @Put(':id/permissions/:capability')
  @UseGuards(SudoGuard)
  @RequireCapabilities('access.manage')
  @ApiBearerAuth()
  @ApiParam({ name: 'capability', description: 'contracts RoleCapability' })
  @ApiOperation({ summary: '사용자 권한 허용·제한·역할 기본값 복원 — 사유·재인증·감사·원자 transaction [대표·관리자]' })
  setPermission(
    @Param('id', PositiveIntPipe) id: number,
    @Param('capability') capability: string,
    @Body() dto: SetUserCapabilityDto,
    @Req() req: Request & { user?: JwtClaims },
  ) {
    return this.access.setPermission(id, capability, dto, req.user!.sub);
  }

  @Patch(':id')
  @UseGuards(SudoGuard)
  @RequireCapabilities('executive.manage')
  @ApiBearerAuth()
  @ApiOperation({ summary: '대표 직접 수정(재인증 필수) — name/phone/email/role. role·email 변경 시 대상 세션 전부 무효. super_admin 대상 400. cookie 세션은 reauth 후 10분 내만 허용(403 SUDO_REQUIRED).' })
  async adminUpdate(@Param('id', PositiveIntPipe) id: number, @Body() dto: AdminUpdateUserDto, @Req() req: Request & { user?: JwtClaims }) {
    const sub = req.user?.sub;
    if (typeof sub !== 'number') throw new UnauthorizedException('인증 정보가 없습니다.');
    return this.users.adminUpdateUser(id, sub, dto);
  }

  @Delete(':id')
  @UseGuards(SudoGuard)
  @RequireCapabilities('executive.manage')
  @ApiBearerAuth()
  @ApiOperation({ summary: '활성 직원 계정 종료(대표·재인증) — authVersion 증가, soft delete, 강사 프로필 전이, audit 원자 tx.' })
  async terminate(
    @Param('id', PositiveIntPipe) id: number,
    @Body() dto: UserLifecycleDto,
    @Req() req: Request & { user?: JwtClaims },
  ) {
    const sub = req.user?.sub;
    if (typeof sub !== 'number') throw new UnauthorizedException('인증 정보가 없습니다.');
    return this.users.terminateUser(id, sub, dto.reason);
  }

  @Post(':id/restore')
  @UseGuards(SudoGuard)
  @RequireCapabilities('executive.manage')
  @ApiBearerAuth()
  @ApiOperation({ summary: '종료된 직원 계정 복구(대표·재인증) — authVersion 증가, 강사 프로필 복구, audit 원자 tx.' })
  async restore(
    @Param('id', PositiveIntPipe) id: number,
    @Body() dto: UserLifecycleDto,
    @Req() req: Request & { user?: JwtClaims },
  ) {
    const sub = req.user?.sub;
    if (typeof sub !== 'number') throw new UnauthorizedException('인증 정보가 없습니다.');
    return this.users.restoreUser(id, sub, dto.reason);
  }
}
