import {
  Req,
  Body,
  Controller,
  ForbiddenException,
  Get,
  Headers,
  Param,
  ParseIntPipe,
  Post,
  Query,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RolesGuard } from './roles.guard';
import { Roles, STAFF_ROLES } from './roles.decorator';
import type { Request } from 'express';
import { AuthService, JwtClaims } from './auth.service';
import { LoginDto } from './dto/login.dto';
import { SignupDto } from './dto/signup.dto';
import { ApproveDto } from './dto/approve.dto';
import { SuperAdminGuard } from './super-admin.guard';
import { UsersService } from '../users/users.service';
import { MailService } from '../mail/mail.service';

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly users: UsersService,
    private readonly mail: MailService,
  ) {}

  // ── 가입 신청 → 이메일 인증 → 대표 승인 → 로그인 ──

  // 1) 가입 신청. 계정은 status=pending·이메일 미인증으로 생성되고 인증 메일을 발송.
  @Post('signup')
  @ApiOperation({ summary: '가입 신청(대표 승인 대기). 인증 메일 발송.' })
  async signup(@Body() dto: SignupDto) {
    const { account, verifyToken } = await this.users.signup(dto);
    const base = process.env.WEB_ORIGIN ?? 'http://localhost:3000';
    const link = `${base}/verify-email?token=${verifyToken}`;
    const mailRes = await this.mail.sendVerifyEmail(account.email, link);
    return {
      ok: true,
      message: '가입 신청이 접수되었습니다. 이메일 인증 후 대표 승인을 기다려 주세요.',
      account: { id: account.id, webId: account.webId, name: account.name, role: account.role, status: account.status },
      // SMTP 미설정(데모)일 때만 인증 링크를 노출(개발 편의). 운영에선 메일로만 전달.
      devVerifyLink: mailRes.devLink,
    };
  }

  // 2) 이메일 인증(메일 링크의 token).
  @Get('verify-email')
  @ApiOperation({ summary: '이메일 인증(token).' })
  async verifyEmail(@Query('token') token?: string) {
    if (!token) throw new UnauthorizedException('인증 토큰이 없습니다.');
    const acc = await this.users.verifyEmail(token);
    return { ok: true, message: '이메일 인증이 완료되었습니다. 대표 승인 후 로그인할 수 있습니다.', account: { id: acc.id, status: acc.status, emailVerified: acc.emailVerified } };
  }

  // 3) 로그인 — 계정 존재·이메일 인증·대표 승인(active)·비밀번호 일치 모두 충족해야 토큰 발급.
  @Post('login')
  @ApiOperation({ summary: '로그인(비밀번호 해시 검증 + 상태 게이트).' })
  async login(@Body() dto: LoginDto): Promise<{ accessToken: string; account: { id: number; name: string; role: string } }> {
    const acc = this.users.findByWebId(dto.webId);
    // 계정 없음/비번 불일치는 동일 메시지(계정 열거 방지)
    const ok = acc ? await this.users.validatePassword(acc, dto.password ?? '') : false;
    if (!acc || !ok) throw new UnauthorizedException('아이디 또는 비밀번호가 올바르지 않습니다.');
    if (!acc.emailVerified) throw new ForbiddenException('이메일 인증이 필요합니다.');
    if (acc.status === 'pending') throw new ForbiddenException('대표 승인 대기 중입니다.');
    if (acc.status === 'rejected') throw new ForbiddenException('가입이 반려된 계정입니다.');
    // [강사 식별자 통일 2026-07-07] sub(=users.id)가 곧 강사 식별자 — 별도 instructorId 클레임 불필요.
    const claims: JwtClaims = { sub: acc.id, name: acc.name, roles: [acc.role] };
    return { accessToken: this.auth.sign(claims), account: { id: acc.id, name: acc.name, role: acc.role } };
  }

  // ── 대표(super_admin) 고유 권한: 승인 관리 ──

  @Get('pending')
  @UseGuards(SuperAdminGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: '승인 대기 계정 목록(대표 전용).' })
  pending() {
    return this.users.listPending();
  }

  @Post('approve/:id')
  @UseGuards(SuperAdminGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: '가입 승인(active 전환, 역할 지정 가능) — 대표 전용.' })
  async approve(@Param('id', ParseIntPipe) id: number, @Body() dto: ApproveDto) {
    const acc = this.users.findById(id);
    if (acc && !acc.emailVerified) throw new ForbiddenException('이메일 인증이 완료되지 않은 계정은 승인할 수 없습니다.');
    return this.users.setStatus(id, 'active', dto.role);
  }

  @Post('reject/:id')
  @UseGuards(SuperAdminGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: '가입 반려 — 대표 전용.' })
  async reject(@Param('id', ParseIntPipe) id: number) {
    return this.users.setStatus(id, 'rejected');
  }

  // 토큰 검증(claims 반환) — [A5 2026-07-06] 수동 Bearer 파싱 → RolesGuard 패턴 통일
  //  (파싱·검증·401 처리를 가드 한 곳으로 — 로그인 계정 role은 전부 STAFF_ROLES 안이므로 동작 동일).
  @Get('me')
  @UseGuards(RolesGuard)
  @Roles(...STAFF_ROLES)
  @ApiOperation({ summary: '토큰 검증 → claims. [로그인]' })
  me(@Req() req: Request & { user?: JwtClaims }) {
    return req.user; // RolesGuard가 검증 후 부착한 claims(iat/exp 포함)
  }
}
