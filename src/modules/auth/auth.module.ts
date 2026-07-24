import { Module, forwardRef } from '@nestjs/common';
import { ThrottlerModule } from '@nestjs/throttler';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { SuperAdminGuard } from './super-admin.guard';
import { SudoGuard } from './sudo.guard'; // [TBO-34 C2-C] 재인증 서버측 강제
import { RolesGuard } from './roles.guard';
import { LoginThrottlerGuard } from './login-throttler.guard';
import { AuthEventsService } from './auth-events.service';
import { RefreshTokensService } from './refresh-tokens.service';
import { SignupEmailChallengesService } from './signup-email-challenges.service';
import { SignupPhoneChallengesService } from './signup-phone-challenges.service'; // [TBO-57]
import { CONTACT_VERIFICATION_PROVIDER } from '../profile-verifications/contact-verification.provider';
import { DefaultContactVerificationProvider } from '../profile-verifications/default-contact-verification.provider';
import { UsersModule } from '../users/users.module';
import { MailModule } from '../mail/mail.module';
import { APP_GUARD } from '@nestjs/core';
import { BrowserOriginGuard } from './browser-origin.guard';
import { DatabaseModule } from '../../database/database.module';
import { PostgresConnectionService } from '../../database/postgres-connection.service';
import { PostgresThrottleStorage } from './postgres-throttle.storage';

@Module({
  imports: [
    forwardRef(() => UsersModule),
    MailModule,
    DatabaseModule,
    // [TBO-28B] /auth/login 전용 rate limit 설정(가드는 login 핸들러에만 적용 — 전역 아님).
    //  NODE_ENV=test 기본 skip(전 e2e가 로그인 다회) — THROTTLE_E2E=1로 명시 활성(스로틀 전용 스펙).
    ThrottlerModule.forRootAsync({
      imports: [DatabaseModule],
      inject: [PostgresConnectionService],
      useFactory: (pg: PostgresConnectionService) => ({
        throttlers: [{ name: 'default', ttl: 60_000, limit: 10 }],
        skipIf: () => process.env.NODE_ENV === 'test' && process.env.THROTTLE_E2E !== '1',
        storage: new PostgresThrottleStorage(pg),
      }),
    }),
  ],
  controllers: [AuthController],
  providers: [
    AuthService,
    SuperAdminGuard,
    SudoGuard,
    BrowserOriginGuard,
    { provide: APP_GUARD, useExisting: BrowserOriginGuard },
    RolesGuard,
    { provide: APP_GUARD, useExisting: RolesGuard },
    LoginThrottlerGuard,
    AuthEventsService,
    RefreshTokensService, // [대표 지시 ④] refresh 회전·폐기 — 쿠키 셋팅은 controller가 담당
    SignupEmailChallengesService, // [TBO-31 C1 D1] 가입 전 이메일 OTP(공개 흐름)
    // [TBO-57] 가입 전 휴대전화 OTP(공개 흐름) — provider 토큰은 ProfileVerificationsModule과 동일
    //  등록(테스트 overrideProvider가 양쪽 모두 대체). AuthModule은 MailModule을 이미 import.
    SignupPhoneChallengesService,
    { provide: CONTACT_VERIFICATION_PROVIDER, useClass: DefaultContactVerificationProvider },
  ],
  // SignupEmailChallengesService export: UsersService.signup이 가입 tx에서 consumeForSignup을 호출
  //  (UsersModule ↔ AuthModule 기존 forwardRef 순환 위에 얹힘 — 주입부는 @Inject(forwardRef)).
  exports: [AuthService, RolesGuard, AuthEventsService, SignupEmailChallengesService, SignupPhoneChallengesService, SuperAdminGuard, SudoGuard],
})
export class AuthModule {}
