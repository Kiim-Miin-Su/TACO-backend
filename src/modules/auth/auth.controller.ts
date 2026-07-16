import {
  Req,
  Res,
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
import { ApiBearerAuth, ApiCreatedResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { RolesGuard } from './roles.guard';
import { Roles, STAFF_ROLES } from './roles.decorator';
import type { Request, Response } from 'express';
import { RefreshTokensService } from './refresh-tokens.service';
import { isForbiddenDemoCredential } from '../../config/production-guards';
import { RecoverIdDto, RecoverPasswordDto, ResetPasswordDto } from './dto/recovery.dto';
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
import { LoginResponseDto } from './dto/login-response.dto';
import { Public } from './public.decorator';

const isProduction = (): boolean => process.env.NODE_ENV === 'production';

// [대표 지시 ④ 2026-07-16] refresh token 쿠키 — httpOnly(JS 접근 불가)·path=/api/auth(갱신/로그아웃만 운반).
//  production은 FE(Vercel)↔BE 교차 출처 XHR이므로 SameSite=None; Secure, 로컬은 Lax.
const REFRESH_COOKIE = 'refresh_token';
const readCookie = (req: Request, name: string): string | undefined =>
  req.headers.cookie?.split(';').map((s) => s.trim()).find((s) => s.startsWith(`${name}=`))?.slice(name.length + 1);

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly users: UsersService,
    private readonly mail: MailService,
    private readonly events: AuthEventsService,
    private readonly refreshTokens: RefreshTokensService,
  ) {}

  // [대표 지시 ④] refresh 쿠키 셋/클리어 — 만료(Max-Age)는 토큰 행의 expiresAt과 동기.
  private setRefreshCookie(res: Response, raw: string, expiresAtIso: string): void {
    res.cookie(REFRESH_COOKIE, raw, {
      httpOnly: true,
      secure: isProduction(),
      sameSite: isProduction() ? 'none' : 'lax',
      path: '/api/auth',
      maxAge: Math.max(0, Date.parse(expiresAtIso) - Date.now()),
    });
  }
  private clearRefreshCookie(res: Response): void {
    res.cookie(REFRESH_COOKIE, '', {
      httpOnly: true, secure: isProduction(), sameSite: isProduction() ? 'none' : 'lax', path: '/api/auth', maxAge: 0,
    });
  }

  // ── 가입 신청 → 이메일 인증 → 대표 승인 → 로그인 ──

  // 1) 가입 신청. 계정은 status=pending·이메일 미인증으로 생성되고 인증 메일을 발송.
  @Post('signup')
  @Public()
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
  @Public()
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
  @Public()
  @UseGuards(LoginThrottlerGuard)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({ summary: '로그인(비밀번호 해시 검증 + 상태 게이트 + rate limit). 성공/실패는 auth_events 기록.' })
  @ApiCreatedResponse({ type: LoginResponseDto })
  async login(
    @Body() dto: LoginDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ accessToken: string; account: { id: number; name: string; role: string; mustChangePassword: boolean } }> {
    await this.users.refreshFromDb(); // [28F] 다른 인스턴스에서 승인/등록된 계정도 즉시 로그인 가능
    const acc = this.users.findByWebId(dto.webId);
    const deny = async (failureCode: string, err: Error): Promise<never> => {
      await this.events.record({ type: 'login_failure', userId: acc?.id, attemptedWebId: dto.webId, failureCode, req });
      throw err;
    };
    // [TBO-29C] demo 자격증명 방어 — 운영에서 demo 비밀번호 로그인은 계정 존재와 무관하게 즉시 거부(심층 방어).
    if (isForbiddenDemoCredential(dto.password))
      await deny('demo_credential_blocked', new UnauthorizedException('아이디 또는 비밀번호가 올바르지 않습니다.'));
    // 계정 없음/비번 불일치는 동일 메시지(계정 열거 방지)
    const ok = acc ? await this.users.validatePassword(acc, dto.password ?? '') : false;
    if (!acc || !ok) await deny('bad_credentials', new UnauthorizedException('아이디 또는 비밀번호가 올바르지 않습니다.'));
    const account = acc as StaffAccount;
    if (!account.emailVerified) await deny('email_unverified', new ForbiddenException('이메일 인증이 필요합니다.'));
    if (account.status === 'pending') await deny('pending_approval', new ForbiddenException('대표 승인 대기 중입니다.'));
    if (account.status === 'rejected') await deny('rejected', new ForbiddenException('가입이 반려된 계정입니다.'));
    if (!isStaffRole(account.role)) await deny('not_staff', new ForbiddenException('백오피스 담당자 계정만 로그인할 수 있습니다.'));
    // [강사 식별자 통일 2026-07-07] sub(=users.id)가 곧 강사 식별자 — 별도 instructorId 클레임 불필요.
    const claims: JwtClaims = {
      sub: account.id,
      name: account.name,
      roles: [account.role],
      authVersion: authVersionOf(account),
      mustChangePassword: account.mustChangePassword === true,
    };
    await this.users.recordLoginSuccess(account.id);
    await this.events.record({ type: 'login_success', userId: account.id, req });
    // [대표 지시 ④] refresh token 발급(httpOnly 쿠키) — access token 만료 후 무중단 갱신 기반.
    const issued = await this.refreshTokens.issue(account.id, authVersionOf(account), String(req.headers['user-agent'] ?? '') || null);
    this.setRefreshCookie(res, issued.raw, issued.row.expiresAt);
    return {
      accessToken: this.auth.sign(claims),
      account: { id: account.id, name: account.name, role: account.role, mustChangePassword: account.mustChangePassword === true },
    };
  }

  // [대표 지시 ④ 2026-07-16] access token 갱신 — refresh 쿠키 검증 → **회전**(새 refresh 발급+구 토큰
  //  폐기·링크) → 새 access token. 계정 상태·auth_version은 발급 시점 권위 소스로 재대조(로그인과 동일
  //  게이트) — 비밀번호 변경/승인 취소 후의 refresh는 여기서 죽는다.
  @Post('refresh')
  @Public()
  @UseGuards(LoginThrottlerGuard)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @ApiOperation({ summary: 'access token 갱신 — refresh 쿠키 회전(재사용 감지 시 전 세션 무효). [쿠키]' })
  async refresh(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ accessToken: string; account: { id: number; name: string; role: string; mustChangePassword: boolean } }> {
    const raw = readCookie(req, REFRESH_COOKIE);
    if (!raw) throw new UnauthorizedException('세션 갱신 정보가 없습니다. 다시 로그인해 주세요.');
    let row;
    try {
      row = await this.refreshTokens.assertRotatable(raw);
    } catch (err) {
      // 재사용 감지 계열은 보안 이벤트로 남긴다(원문 토큰은 기록하지 않음 — hash도 남기지 않음).
      const rowForEvent = await this.refreshTokens.findByRaw(raw);
      if (rowForEvent?.revokedAt != null) {
        await this.events.record({ type: 'refresh_reuse_blocked', userId: rowForEvent.userId, failureCode: 'revoked_reuse', req });
      }
      this.clearRefreshCookie(res);
      throw err;
    }
    await this.users.refreshFromDb();
    const account = this.users.findById(row.userId);
    const invalidate = async (): Promise<never> => {
      await this.refreshTokens.revokeAllForUser(row.userId);
      this.clearRefreshCookie(res);
      throw new UnauthorizedException('세션이 더 이상 유효하지 않습니다. 다시 로그인해 주세요.');
    };
    if (!account || account.deletedAt != null || account.status !== 'active' || !isStaffRole(account.role)) return invalidate();
    if (authVersionOf(account) !== row.authVersion) return invalidate(); // 자격증명/역할 변경 후의 구 refresh
    const next = await this.refreshTokens.issue(account.id, authVersionOf(account), String(req.headers['user-agent'] ?? '') || null);
    await this.refreshTokens.markRotated(row.id, next.row.id);
    this.setRefreshCookie(res, next.raw, next.row.expiresAt);
    const claims: JwtClaims = {
      sub: account.id,
      name: account.name,
      roles: [account.role],
      authVersion: authVersionOf(account),
      mustChangePassword: account.mustChangePassword === true,
    };
    return {
      accessToken: this.auth.sign(claims),
      account: { id: account.id, name: account.name, role: account.role, mustChangePassword: account.mustChangePassword === true },
    };
  }

  // ── [TBO-29C C5] 비로그인 복구 — 아이디 찾기·비밀번호 재설정 ──────────────────
  //  응답은 계정 존재/일치 여부와 무관하게 동일(열거 방지). 실패 사유는 auth_events로만 추적.
  //  dev(무SMTP·비production)는 devWebId/devResetUrl을 응답에 포함(기존 signup devLink 규약과 동일).
  @Post('recover-id')
  @Public()
  @UseGuards(LoginThrottlerGuard)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({ summary: '아이디 찾기 — 가입 이메일이 일치하면 아이디를 메일로 안내(항상 동일 응답).' })
  async recoverId(@Body() dto: RecoverIdDto, @Req() req: Request): Promise<{ ok: true; message: string; devWebId?: string }> {
    await this.users.refreshFromDb();
    const acc = this.users.findActiveByEmail(dto.email);
    let devWebId: string | undefined;
    if (acc?.email) {
      const sentResult = await this.mail.sendRecoverIdEmail(acc.email, acc.webId);
      if (process.env.NODE_ENV !== 'production') devWebId = sentResult.devWebId;
    }
    await this.events.record({ type: 'recover_id_requested', userId: acc?.id, attemptedWebId: dto.email, req });
    return { ok: true, message: '가입된 이메일이면 아이디 안내 메일을 보냈습니다.', ...(devWebId ? { devWebId } : {}) };
  }

  @Post('recover-password')
  @Public()
  @UseGuards(LoginThrottlerGuard)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({ summary: '비밀번호 재설정 요청 — 아이디+이메일이 일치하면 1시간 유효 링크 발송(항상 동일 응답).' })
  async recoverPassword(@Body() dto: RecoverPasswordDto, @Req() req: Request): Promise<{ ok: true; message: string; devResetUrl?: string }> {
    const { account, resetToken } = await this.users.beginPasswordReset(dto.webId, dto.email);
    let devResetUrl: string | undefined;
    if (account?.email && resetToken) {
      const base = process.env.WEB_ORIGIN ?? 'http://localhost:3000';
      const link = `${base}/reset-password?token=${resetToken}`;
      const sentResult = await this.mail.sendPasswordResetEmail(account.email, link);
      if (process.env.NODE_ENV !== 'production') devResetUrl = sentResult.devLink;
    }
    await this.events.record({ type: 'password_reset_requested', userId: account?.id, attemptedWebId: dto.webId, req });
    return { ok: true, message: '아이디와 이메일이 일치하면 재설정 링크를 보냈습니다.', ...(devResetUrl ? { devResetUrl } : {}) };
  }

  @Post('reset-password')
  @Public()
  @UseGuards(LoginThrottlerGuard)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({ summary: '비밀번호 재설정 확정 — 토큰 검증 후 변경. 성공 시 기존 세션 전부 무효(auth_version+1).' })
  async resetPassword(@Body() dto: ResetPasswordDto, @Req() req: Request): Promise<{ ok: true }> {
    const account = await this.users.resetPasswordWithToken(dto.token, dto.newPassword);
    await this.events.record({ type: 'password_reset_completed', userId: account.id, req });
    return { ok: true };
  }

  // 4) 로그아웃 — [대표 지시 ④] refresh 쿠키 토큰 폐기 + 쿠키 클리어 + 보안 이벤트.
  //  access token 만료 후에도 refresh 폐기가 가능해야 하므로 @Public(bearer는 있으면 이벤트 귀속용).
  @Post('logout')
  @Public()
  @ApiOperation({ summary: '로그아웃 — refresh token 폐기(쿠키)·클리어 + auth_events 기록(access token은 클라이언트가 폐기).' })
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    let userId: number | undefined;
    const bearer = req.headers.authorization?.replace(/^Bearer\s+/i, '');
    if (bearer) {
      try { userId = this.auth.verify(bearer).sub; } catch { /* 만료/무효 토큰 — 귀속 없이 진행 */ }
    }
    const raw = readCookie(req, REFRESH_COOKIE);
    if (raw) {
      const row = await this.refreshTokens.findByRaw(raw);
      userId = userId ?? row?.userId;
      await this.refreshTokens.revokeByRaw(raw);
    }
    this.clearRefreshCookie(res);
    await this.events.record({ type: 'logout', userId, req });
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
  async me(@Req() req: Request & { user?: JwtClaims }) {
    const claims = req.user;
    if (!claims) throw new UnauthorizedException('인증 정보가 없습니다.');
    await this.users.refreshFromDb();
    const account = this.users.findById(claims.sub);
    if (!account) throw new UnauthorizedException('계정 정보를 확인할 수 없습니다.');
    return {
      ...claims,
      name: account.name,
      roles: [account.role],
      mustChangePassword: account.mustChangePassword === true,
    };
  }
}
