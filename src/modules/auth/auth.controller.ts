import {
  Req,
  Res,
  BadRequestException,
  Body,
  Controller,
  Delete,
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
import { ADMIN_ROLES, Roles, STAFF_ROLES } from './roles.decorator';
import type { Request, Response } from 'express';
import { RefreshTokensService } from './refresh-tokens.service';
import { isForbiddenDemoCredential } from '../../config/production-guards';
import { RecoverIdDto, RecoverPasswordDto, ResetPasswordDto } from './dto/recovery.dto';
import { AuthService, JwtClaims } from './auth.service';
import { LoginDto } from './dto/login.dto';
import { SignupDto } from './dto/signup.dto';
import { CompleteRecoverIdDto, ConfirmSignupEmailChallengeDto, CreateSignupEmailChallengeDto, ReauthDto, ResetPasswordOtpDto } from './dto/signup-email-challenge.dto';
import { SignupEmailChallengesService } from './signup-email-challenges.service';
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
import {
  ACCESS_COOKIE,
  REFRESH_COOKIE,
  clearBrowserSession,
  readCookie,
  setAccessCookie,
  setRefreshCookie,
} from './browser-session';

const isProduction = (): boolean => process.env.NODE_ENV === 'production';

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly users: UsersService,
    private readonly mail: MailService,
    private readonly events: AuthEventsService,
    private readonly refreshTokens: RefreshTokensService,
    private readonly signupChallenges: SignupEmailChallengesService,
  ) {}

  // ── 가입 전 이메일 OTP → 가입 신청 → 대표 승인 → 로그인 ──

  // 0-a) [TBO-31 C1 D1] 가입 전 이메일 OTP 발송 — 공개(비로그인). 이미 가입된 이메일도 **응답 동일**
  //  (실제 발송만 생략 — 계정 열거 방지, H2 재발 방지 규약). devOtpCode는 비production+SMTP 부재에서만.
  @Post('signup-email-challenge')
  @Public()
  @UseGuards(LoginThrottlerGuard)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @ApiOperation({ summary: '가입 전 이메일 OTP 발송(공개) — 5회/분. 가입 여부와 무관하게 동일 응답(열거 방지).' })
  createSignupEmailChallenge(@Body() dto: CreateSignupEmailChallengeDto) {
    return this.signupChallenges.create(dto.email);
  }

  // 0-b) OTP 확인 — 실패 5회 잠금·만료 10분. 실패는 GENERIC 400(존재 은닉 — 스펙 §2 D1).
  @Post('signup-email-challenge/:id/confirm')
  @Public()
  @UseGuards(LoginThrottlerGuard)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({ summary: '가입 전 이메일 OTP 확인(공개) — 10회/분, 실패 5회 잠금, 성공 시 verified.' })
  confirmSignupEmailChallenge(@Param('id', ParseIntPipe) id: number, @Body() dto: ConfirmSignupEmailChallengeDto) {
    return this.signupChallenges.confirm(id, dto.email, dto.code);
  }

  // 0-c) [TBO-31 C1 D3] 아이디 가용성 공개 체크 — 응답은 {available: boolean} **만**.
  //  이름·역할은 절대 노출하지 않는다: 과거 무인증 /users/exists가 name/role을 노출해 계정 열거
  //  취약(H2)이 됐던 전례 — 그 API는 STAFF 전용으로 잠갔고, 공개 체크는 boolean 단일 필드로 신설.
  @Get('web-id-available')
  @Public()
  @UseGuards(LoginThrottlerGuard)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({ summary: '아이디 사용 가능 여부(공개) — {available}만 반환(이름·역할 미노출), 10회/분.' })
  async webIdAvailable(@Query('webId') webId?: string): Promise<{ available: boolean }> {
    const trimmed = webId?.trim() ?? '';
    if (trimmed.length < 3) throw new BadRequestException('아이디는 3자 이상이어야 합니다.');
    await this.users.refreshFromDb(); // [28F] 교차 인스턴스 정합 — 방금 가입한 아이디도 즉시 반영
    return { available: !this.users.findByWebId(trimmed) };
  }

  // 1) 가입 신청 — [TBO-31 C1 D1] verified 이메일 OTP(emailChallengeId)를 가입 tx에서 일회 소비하고
  //  계정을 **emailVerified=true로 생성**한다(48h 인증 링크 단계 소멸 — sendVerifyEmail·devVerifyLink 제거).
  @Post('signup')
  @Public()
  @ApiOperation({ summary: '가입 신청(대표 승인 대기) — 이메일 OTP 소비, emailVerified=true 생성.' })
  async signup(@Body() dto: SignupDto) {
    const { account } = await this.users.signup(dto);
    return {
      ok: true,
      message: '가입 신청이 접수되었습니다. 대표 승인 후 로그인할 수 있습니다.',
      account: { id: account.id, webId: account.webId, name: account.name, role: account.role, status: account.status },
    };
  }

  // 2) 이메일 인증(메일 링크의 token). [TBO-28B] 토큰=sha256 hash 대조 + 48h 만료, 성공 시 명시 NULL 클리어.
  //  [TBO-31 C1] 신규 가입은 OTP로 verified 생성이라 이 링크를 만들지 않는다 — **잔존 pending 계정
  //  (구 가입 흐름의 미인증 계정) 호환용으로만 유지**한다.
  @Get('verify-email')
  @Public()
  @ApiOperation({ summary: '이메일 인증(token) — hash 대조·48h 만료. [잔존 계정 호환]' })
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
  ): Promise<{ accessToken?: string; account: { id: number; name: string; role: string; mustChangePassword: boolean } }> {
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
    setRefreshCookie(res, issued.raw, issued.row.expiresAt);
    const accessToken = this.auth.sign(claims);
    const accessClaims = this.auth.verify(accessToken);
    setAccessCookie(res, accessToken, (accessClaims.exp ?? Math.floor(Date.now() / 1000) + 3600) * 1000);
    return {
      ...(!isProduction() ? { accessToken } : {}),
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
  ): Promise<{ accessToken?: string; account: { id: number; name: string; role: string; mustChangePassword: boolean } }> {
    const raw = readCookie(req, REFRESH_COOKIE);
    if (!raw) {
      // HttpOnly access cookie는 frontend JavaScript가 지울 수 없다. refresh가 없으면 여기서 함께
      // 만료시켜 Next middleware의 stale-cookie login redirect loop를 막는다.
      clearBrowserSession(res);
      throw new UnauthorizedException('세션 갱신 정보가 없습니다. 다시 로그인해 주세요.');
    }
    let row;
    try {
      row = await this.refreshTokens.assertRotatable(raw);
    } catch (err) {
      // 재사용 감지 계열은 보안 이벤트로 남긴다(원문 토큰은 기록하지 않음 — hash도 남기지 않음).
      const rowForEvent = await this.refreshTokens.findByRaw(raw);
      if (rowForEvent?.revokedAt != null) {
        await this.events.record({ type: 'refresh_reuse_blocked', userId: rowForEvent.userId, failureCode: 'revoked_reuse', req });
      }
      clearBrowserSession(res);
      throw err;
    }
    await this.users.refreshFromDb();
    const account = this.users.findById(row.userId);
    const invalidate = async (): Promise<never> => {
      await this.refreshTokens.revokeAllForUser(row.userId);
      clearBrowserSession(res);
      throw new UnauthorizedException('세션이 더 이상 유효하지 않습니다. 다시 로그인해 주세요.');
    };
    if (!account || account.deletedAt != null || account.status !== 'active' || !isStaffRole(account.role)) return invalidate();
    if (authVersionOf(account) !== row.authVersion) return invalidate(); // 자격증명/역할 변경 후의 구 refresh
    const next = await this.refreshTokens.issue(account.id, authVersionOf(account), String(req.headers['user-agent'] ?? '') || null);
    await this.refreshTokens.markRotated(row.id, next.row.id);
    setRefreshCookie(res, next.raw, next.row.expiresAt);
    const claims: JwtClaims = {
      sub: account.id,
      name: account.name,
      roles: [account.role],
      authVersion: authVersionOf(account),
      mustChangePassword: account.mustChangePassword === true,
    };
    const accessToken = this.auth.sign(claims);
    const accessClaims = this.auth.verify(accessToken);
    setAccessCookie(res, accessToken, (accessClaims.exp ?? Math.floor(Date.now() / 1000) + 3600) * 1000);
    return {
      ...(!isProduction() ? { accessToken } : {}),
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

  // ── [TBO-31 C5 D9] 비로그인 복구 — 인라인 OTP판(위 링크판과 병존: 마이페이지 메일 경로+폴백) ──
  //  발송/확인은 가입 OTP와 동일 상수(TTL 10분·시도 5회·쿨다운 60초)·동일 스로틀 규약.
  //  recovery는 가입 여부와 무관하게 항상 발송(D8) — 응답 동일·인증 후에만 결과 노출(열거 아님).
  @Post('recovery-email-challenge')
  @Public()
  @UseGuards(LoginThrottlerGuard)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @ApiOperation({ summary: '복구용 이메일 OTP 발송(공개) — 5회/분. 가입 여부와 무관하게 동일 응답.' })
  createRecoveryEmailChallenge(@Body() dto: CreateSignupEmailChallengeDto) {
    return this.signupChallenges.create(dto.email, 'recovery');
  }

  @Post('recovery-email-challenge/:id/confirm')
  @Public()
  @UseGuards(LoginThrottlerGuard)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({ summary: '복구용 이메일 OTP 확인(공개) — 10회/분, 실패 5회 잠금, 성공 시 verified.' })
  confirmRecoveryEmailChallenge(@Param('id', ParseIntPipe) id: number, @Body() dto: ConfirmSignupEmailChallengeDto) {
    return this.signupChallenges.confirm(id, dto.email, dto.code, 'recovery');
  }

  //  아이디 찾기 완료 — OTP 인증한 이메일의 active 계정 webId를 화면에 즉시 표시(메일 왕복 제거).
  //  challenge는 일회 소비(재호출 400). 계정이 없으면 webIds: [](이메일 소유 증명 후라 열거 아님).
  @Post('recover-id/complete')
  @Public()
  @UseGuards(LoginThrottlerGuard)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({ summary: '아이디 찾기 완료(공개) — verified recovery OTP 일회 소비 후 webId 목록 반환.' })
  async completeRecoverId(@Body() dto: CompleteRecoverIdDto, @Req() req: Request): Promise<{ webIds: string[] }> {
    const { webIds, firstUserId } = await this.users.completeRecoverIdOtp(dto.challengeId, dto.email);
    await this.events.record({ type: 'recover_id_completed', userId: firstUserId ?? undefined, attemptedWebId: dto.email, req });
    return { webIds };
  }

  //  비밀번호 재설정(OTP판) — webId+이메일+verified challenge 3중 일치 시 즉시 변경(링크 왕복 제거).
  //  성공 = auth_version+1(기존 세션 전멸) + 발급돼 있던 링크 토큰 동시 무효.
  @Post('reset-password-otp')
  @Public()
  @UseGuards(LoginThrottlerGuard)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({ summary: '비밀번호 재설정 확정(OTP·공개) — 성공 시 기존 세션 전부 무효(auth_version+1).' })
  async resetPasswordOtp(@Body() dto: ResetPasswordOtpDto, @Req() req: Request): Promise<{ ok: true }> {
    const account = await this.users.resetPasswordWithOtp(dto.challengeId, dto.webId, dto.email, dto.newPassword);
    await this.events.record({ type: 'password_reset_completed', userId: account.id, req });
    return { ok: true };
  }

  // 4) 로그아웃 — [대표 지시 ④] refresh 쿠키 토큰 폐기 + 쿠키 클리어 + 보안 이벤트.
  //  access token 만료 후에도 refresh 폐기가 가능해야 하므로 @Public(bearer는 있으면 이벤트 귀속용).
  @Post('logout')
  @Public()
  @ApiOperation({ summary: '로그아웃 — access/refresh cookie 폐기·refresh row revoke + auth_events 기록.' })
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    let userId: number | undefined;
    const access = req.headers.authorization?.replace(/^Bearer\s+/i, '') || readCookie(req, ACCESS_COOKIE);
    if (access) {
      try { userId = this.auth.verify(access).sub; } catch { /* 만료/무효 토큰 — 귀속 없이 진행 */ }
    }
    const raw = readCookie(req, REFRESH_COOKIE);
    if (raw) {
      const row = await this.refreshTokens.findByRaw(raw);
      userId = userId ?? row?.userId;
      await this.refreshTokens.revokeByRaw(raw);
    }
    clearBrowserSession(res);
    await this.events.record({ type: 'logout', userId, req });
    return { ok: true };
  }

  // [유저 관리 2026-07-20 대표 지시] 재인증 게이트 — 민감 화면(유저 상세) 진입 전 비밀번호 재확인.
  //  검증만 하고 토큰을 새로 발급하지 않는다(세션 부작용 0). 오답은 로그인과 동일 문구·스로틀.
  @Post('reauth')
  @UseGuards(RolesGuard, LoginThrottlerGuard)
  @Roles(...STAFF_ROLES)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @ApiBearerAuth()
  @ApiOperation({ summary: '비밀번호 재확인(로그인 상태) — 민감 화면 진입 게이트. 5회/분.' })
  async reauth(@Body() dto: ReauthDto, @Req() req: Request & { user?: JwtClaims }): Promise<{ ok: true }> {
    const sub = req.user?.sub;
    if (typeof sub !== 'number') throw new UnauthorizedException('인증 정보가 없습니다.');
    await this.users.refreshFromDb();
    const account = this.users.findById(sub);
    if (!account || !(await this.users.validatePassword(account, dto.currentPassword))) {
      throw new BadRequestException('비밀번호가 올바르지 않습니다.');
    }
    return { ok: true };
  }

  // ── 가입 승인 관리 ──

  @Get('pending')
  @UseGuards(RolesGuard)
  @Roles(...ADMIN_ROLES)
  @ApiBearerAuth()
  @ApiOperation({ summary: '처리 가능한 승인 대기 계정 목록(매니저=강사, 관리자=강사·매니저, 대표=대표 외).' })
  pending(@Req() req: Request & { user?: JwtClaims }) {
    return this.users.listPending(this.actorOf(req));
  }

  // [TBO-28B] 원자적 승인 command — actor=JWT sub(바디 위조 불가), users CAS + instructor_profiles + audit_log 단일 tx.
  //  동시 approve/approve·approve/reject는 한 command만 성공(나머지 409). 미인증 계정 403(검사도 CAS 안).
  @Post('approve/:id')
  @UseGuards(RolesGuard)
  @Roles(...ADMIN_ROLES)
  @ApiBearerAuth()
  @ApiOperation({ summary: '가입 승인(요청 역할 보존, 역할별 범위 강제, 원자 tx+audit). 동시 결정은 409.' })
  async approve(@Param('id', ParseIntPipe) id: number, @Body() dto: ApproveDto, @Req() req: Request & { user?: JwtClaims }) {
    return this.users.approve(id, this.actorOf(req), dto.reason);
  }

  // [핫픽스 2026-07-20] 레거시 pending 계정 인증 메일 재발송 — 구 링크 가입자가 SMTP 부재기에
  //  메일을 못 받아 인증 불가 → 승인 403에 갇힌 케이스 구제(대표 실사용 보고: 강사 승인 불가).
  @Post('pending/:id/resend-verification')
  @UseGuards(SuperAdminGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: '승인 대기 계정 인증 메일 재발송(새 48h 토큰) — 대표 전용. 미인증 pending만.' })
  async resendPendingVerification(@Param('id', ParseIntPipe) id: number, @Req() req: Request & { user?: JwtClaims }) {
    const { account, verifyToken } = await this.users.resendVerificationEmail(id, this.actorOf(req));
    const base = process.env.WEB_ORIGIN ?? 'http://localhost:3000';
    const link = `${base}/verify-email?token=${verifyToken}`;
    const sent = await this.mail.sendVerifyEmail(account.email as string, link);
    return {
      ok: true as const,
      message: '인증 메일을 다시 보냈습니다.',
      ...(!isProduction() && sent.devLink ? { devVerifyLink: sent.devLink } : {}),
    };
  }

  @Post('reject/:id')
  @UseGuards(RolesGuard)
  @Roles(...ADMIN_ROLES)
  @ApiBearerAuth()
  @ApiOperation({ summary: '가입 반려(역할별 범위 강제, 사유 필수, audit 기록). 동시 결정은 409.' })
  async reject(@Param('id', ParseIntPipe) id: number, @Body() dto: RejectDto, @Req() req: Request & { user?: JwtClaims }) {
    return this.users.reject(id, this.actorOf(req), dto.reason);
  }

  // [핫픽스 2026-07-20] 가입 신청 삭제 — pending/rejected만. 식별자 해제(같은 아이디·이메일 재가입
  //  허용)+RRN 파기+soft delete+audit. 하드 UNIQUE 때문에 반려만으론 재가입이 영구 차단되던 문제 해소.
  @Delete('pending/:id')
  @UseGuards(SuperAdminGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: '가입 신청 삭제(pending·rejected만) — 식별자 해제·RRN 파기·audit. 대표 전용.' })
  async deletePending(@Param('id', ParseIntPipe) id: number, @Body() dto: RejectDto, @Req() req: Request & { user?: JwtClaims }) {
    return this.users.deletePendingAccount(id, this.actorOf(req), dto.reason);
  }

  /** 검증된 JWT의 sub만 actor로 쓴다(불변식 §5-4). 인증 가드가 req.user를 부착한다. */
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
