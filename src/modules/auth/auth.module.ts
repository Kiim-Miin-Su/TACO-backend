import { Module } from '@nestjs/common';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { SuperAdminGuard } from './super-admin.guard';
import { RolesGuard } from './roles.guard';
import { UsersModule } from '../users/users.module';
import { MailModule } from '../mail/mail.module';

@Module({
  imports: [UsersModule, MailModule],
  controllers: [AuthController],
  providers: [AuthService, SuperAdminGuard, RolesGuard],
  exports: [AuthService, RolesGuard],
})
export class AuthModule {}
