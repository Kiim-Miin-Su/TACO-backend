import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { AuthModule } from '../auth/auth.module';
import { UsersModule } from '../users/users.module';
import { ProfileVerificationsModule } from '../profile-verifications/profile-verifications.module';
import { ProfileChangeRequestsController } from './profile-change-requests.controller';
import { ProfileChangeRequestsService } from './profile-change-requests.service';

@Module({
  imports: [AuthModule, UsersModule, AuditModule, ProfileVerificationsModule],
  controllers: [ProfileChangeRequestsController],
  providers: [ProfileChangeRequestsService],
  exports: [ProfileChangeRequestsService],
})
export class ProfileChangeRequestsModule {}
