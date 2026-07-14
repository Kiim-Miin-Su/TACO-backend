import { Module, forwardRef } from '@nestjs/common';
import { ThrottlerModule } from '@nestjs/throttler';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { SuperAdminGuard } from './super-admin.guard';
import { RolesGuard } from './roles.guard';
import { LoginThrottlerGuard } from './login-throttler.guard';
import { AuthEventsService } from './auth-events.service';
import { UsersModule } from '../users/users.module';
import { MailModule } from '../mail/mail.module';
import { APP_GUARD } from '@nestjs/core';

@Module({
  imports: [
    forwardRef(() => UsersModule),
    MailModule,
    // [TBO-28B] /auth/login 전용 rate limit 설정(가드는 login 핸들러에만 적용 — 전역 아님).
    //  NODE_ENV=test 기본 skip(전 e2e가 로그인 다회) — THROTTLE_E2E=1로 명시 활성(스로틀 전용 스펙).
    ThrottlerModule.forRoot({
      throttlers: [{ name: 'default', ttl: 60_000, limit: 10 }],
      skipIf: () => process.env.NODE_ENV === 'test' && process.env.THROTTLE_E2E !== '1',
    }),
  ],
  controllers: [AuthController],
  providers: [
    AuthService,
    SuperAdminGuard,
    RolesGuard,
    { provide: APP_GUARD, useExisting: RolesGuard },
    LoginThrottlerGuard,
    AuthEventsService,
  ],
  exports: [AuthService, RolesGuard, AuthEventsService],
})
export class AuthModule {}
