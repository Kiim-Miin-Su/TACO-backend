import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { MailModule } from '../mail/mail.module';
import { UsersModule } from '../users/users.module';
import { ProfileVerificationsController } from './profile-verifications.controller';
import { ProfileVerificationsService } from './profile-verifications.service';
import { CONTACT_VERIFICATION_PROVIDER } from './contact-verification.provider';
import { DefaultContactVerificationProvider } from './default-contact-verification.provider';

// [TBO-29B-4] 연락처 재인증 — provider는 토큰으로 주입(테스트에서 deterministic fake로 override).
@Module({
  imports: [AuthModule, UsersModule, MailModule],
  controllers: [ProfileVerificationsController],
  providers: [
    ProfileVerificationsService,
    { provide: CONTACT_VERIFICATION_PROVIDER, useClass: DefaultContactVerificationProvider },
  ],
  exports: [ProfileVerificationsService],
})
export class ProfileVerificationsModule {}
