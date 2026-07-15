import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { AuthModule } from '../auth/auth.module';
import { CatalogModule } from '../catalog/catalog.module';
import { UsersModule } from '../users/users.module';
import { ProfileVerificationsModule } from '../profile-verifications/profile-verifications.module';
import { ProfileChangeRequestsController } from './profile-change-requests.controller';
import { ProfileChangeRequestsService } from './profile-change-requests.service';

@Module({
  imports: [AuthModule, UsersModule, AuditModule, ProfileVerificationsModule, CatalogModule], // [E0.5 ④] 국가·시간대 카탈로그 검증
  controllers: [ProfileChangeRequestsController],
  providers: [ProfileChangeRequestsService],
  exports: [ProfileChangeRequestsService],
})
export class ProfileChangeRequestsModule {}
