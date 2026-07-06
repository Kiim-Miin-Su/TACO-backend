import { Module } from '@nestjs/common';
import { AuditService } from './audit.service';
import { AuditController } from './audit.controller';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [AuthModule], // RolesGuard(AuthService) 주입 — 조회 관리자 전용
  controllers: [AuditController],
  providers: [AuditService],
  exports: [AuditService], // schedule·availability·schedule-requests가 log() 사용
})
export class AuditModule {}
