import {
  Req,
  Body,
  Controller,
  ForbiddenException,
  Get,
  Param,
  ParseIntPipe,
  Post,
  Query,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { RolesGuard } from './roles.guard';
import { Roles, STAFF_ROLES } from './roles.decorator';
import type { Request } from 'express';
import { AuthService, JwtClaims } from './auth.service';
import { LoginDto } from './dto/login.dto';
import { SignupDto } from './dto/signup.dto';
import { ApproveDto } from './dto/approve.dto';
import { RejectDto } from './dto/reject.dto';
import { SuperAdminGuard } from './super-admin.guard';
import { LoginThrottlerGuard } from './login-throttler.guard';
import { AuthEventsService } from './auth-events.service';
import { UsersService } from '../users/users.service';
import { authVersionOf, isStaffRole, type StaffAccount } from '../users/user.entity';
import { MailService } from '../mail/mail.service';

const isProduction = (): boolean => process.env.NODE_ENV === 'production';

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly users: UsersService,
    private readonly mail: MailService,
    private readonly events: AuthEventsService,
  ) {}

  // ── 가입 신청 → 이메일 인증 → 대표 승인 → 로그인 ──

  // 1) 가입 신청. 계정은 status=pending·이메일 미인증으로 생성되고 인증 메일을 발송.
  @Post('signup')
  @ApiOperation({ summary: '가입 신청(대표 승인 대기). 인증 메일 발송.' })
  async signup(@Body() dto: SignupDto) {
    const { account, verifyToken } = await this.users.signup(dto);
    const base = process.env.WEB_ORIGIN ?? 'http://localhost:3000';
    const link = `${base}/verify-email?token=${verifyToken}`;
    const mailRes = await this.mail.sendVerifyEmail(account.email as string /* SignupDto가 email 필수 보장 */, link);
    return {
      ok: true,
      message: '가입 신청이 접수되었습니다. 이메일 인증 후 대표 승인을 기다려 주세요.',
      account: { id: account.id, webId: account.webId, name: account.name, role: account.role, status: account.status },
      // [TBO-28B §4-c] devVerifyLink는 비-production + SMTP 미설정에서만 존재(MailService가 이중 차단).
      //  production은 부팅 fail-fast(SMTP 필수)로 이 분기 자체가 없다.
      ...(mailRes.devLink && !isProduction() ? { devVerifyLink: mailRes.devLink } : {}),
    };
  }

  // 2) 이메일 인증(메일 링크의 token). [TBO-28B] 토큰=sha256 hash 대조 + 48h 만료, 성공 시 명시 NULL 클리어.
  @Get('verify-email')
  @ApiOperation({ summary: '이메일 인증(token) — hash 대조·48h 만료.' })
  async verifyEmail(@Query('token') token?: string) {
    if (!token) throw new UnauthorizedException('인증 토큰이 없습니다.');
    const acc = await this.users.verifyEmail(token);
    return { ok: true, message: '이메일 인증이 완료되었습니다. 대표 승인 후 로그인할 수 있습니다.', account: { id: acc.id, status: acc.status, emailVerified: acc.emailVerified } };
  }

  // 3) 로그인 — 계정 존재·이메일 인증·대표 승인(active)·비밀번호 일치 모두 충족해야 토큰 발급.
  //  [TBO-28B] 성공/실패를 auth_events에 append-only 기록(원문 credential 저장 금지) + last_login_at 갱신.
  //  브루트포스 완화: LoginThrottlerGuard(10회/60초/IP — x-forwarded-for 인지). 429 응답.
  @Post('login')
  @UseGuards(LoginThrottlerGuard)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({ summary: '로그인(비밀번호 해시 검증 + 상태 게이트 + rate limit). 성공/실패는 auth_events 기록.' })
  async login(@Body() dto: LoginDto, @Req() req: Request): Promise<{ accessToken: string; account: { id: number; name: string; role: string } }> {
    const acc = this.users.findByWebId(dto.webId);
    const deny = async (failureCode: string, err: Error): Promise<never> => {
      await this.events.record({ type: 'login_failure', userId: acc?.id, attemptedWebId: dto.webId, failureCode, req });
      throw err;
    };
    // 계정 없음/비번 불일치는 동일 메시지(계정 열거 방지)
    const ok = acc ? await this.users.validatePassword(acc, dto.password ?? '') : false;
    if (!acc || !ok) await deny('bad_credentials', new UnauthorizedException('아이디 또는 비밀번호가 올바르지 않습니다.'));
    const account = acc as StaffAccount;
    if (!account.emailVerified) await deny('email_unverified', new ForbiddenException('이메일 인증이 필요합니다.'));
    if (account.status === 'pending') await deny('pending_approval', new ForbiddenException('대표 승인 대기 중입니다.'));
    if (account.status === 'rejected') await deny('rejected', new ForbiddenException('가입이 반려된 계정입니다.'));
    if (!isStaffRole(account.role)) await deny('not_staff', new ForbiddenException('백오피스 담당자 계정만 로그인할 수 있습니다.'));
    // [강사 식별자 통일 2026-07-07] sub(=users.id)가 곧 강사 식별자 — 별도 instructorId 클레임 불필요.
    const claims: JwtClaims = { sub: account.id, name: account.name, roles: [account.role], authVersion: authVersionOf(account) };
    await this.users.recordLoginSuccess(account.id);
    await this.events.record({ type: 'login_success', userId: account.id, req });
    return { accessToken: this.auth.sign(claims), account: { id: account.id, name: account.name, role: account.role } };
  }

  // 4) 로그아웃 — stateless JWT라 서버 무효화는 없지만 보안 이벤트로 기록한다(FE가 best-effort 호출).
  @Post('logout')
  @UseGuards(RolesGuard)
  @Roles(...STAFF_ROLES)
  @ApiBearerAuth()
  @ApiOperation({ summary: '로그아웃 — auth_events 기록(토큰은 클라이언트가 폐기).' })
  async logout(@Req() req: Request & { user?: JwtClaims }) {
    await this.events.record({ type: 'logout', userId: req.user?.sub, req });
    return { ok: true };
  }

  // ── 대표(super_admin) 고유 권한: 승인 관리 ──

  @Get('pending')
  @UseGuards(SuperAdminGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: '승인 대기 계정 목록(대표 전용).' })
  pending() {
    return this.users.listPending();
  }

  // [TBO-28B] 원자적 승인 command — actor=JWT sub(바디 위조 불가), users CAS + instructor_profiles + audit_log 단일 tx.
  //  동시 approve/approve·approve/reject는 한 command만 성공(나머지 409). 미인증 계정 403(검사도 CAS 안).
  @Post('approve/:id')
  @UseGuards(SuperAdminGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: '가입 승인(원자 tx: 상태+승인메타+강사프로필+audit, 역할 지정 가능) — 대표 전용. 동시 결정은 409.' })
  async approve(@Param('id', ParseIntPipe) id: number, @Body() dto: ApproveDto, @Req() req: Request & { user?: JwtClaims }) {
    return this.users.approve(id, this.actorOf(req), dto.role, dto.reason);
  }

  @Post('reject/:id')
  @UseGuards(SuperAdminGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: '가입 반려(사유 필수, audit 기록) — 대표 전용. 동시 결정은 409.' })
  async reject(@Param('id', ParseIntPipe) id: number, @Body() dto: RejectDto, @Req() req: Request & { user?: JwtClaims }) {
    return this.users.reject(id, this.actorOf(req), dto.reason);
  }

  /** 검증된 JWT의 sub만 actor로 쓴다(불변식 §5-4). SuperAdminGuard가 req.user를 부착한다. */
  private actorOf(req: Request & { user?: JwtClaims }): number {
    const sub = req.user?.sub;
    if (typeof sub !== 'number') throw new UnauthorizedException('인증 정보가 없습니다.');
    return sub;
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
