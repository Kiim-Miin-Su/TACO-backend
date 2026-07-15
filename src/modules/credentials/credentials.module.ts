import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { UsersModule } from '../users/users.module';
import { ProfileVerificationsModule } from '../profile-verifications/profile-verifications.module';
import { CredentialsController } from './credentials.controller';
import { CredentialsService } from './credentials.service';

// [E0] 자격증명 변경(비밀번호 이메일 OTP) — Users↔ProfileVerifications 순환 회피용 제3 모듈.
@Module({
  imports: [AuthModule, UsersModule, ProfileVerificationsModule],
  controllers: [CredentialsController],
  providers: [CredentialsService],
})
export class CredentialsModule {}
