import { Module } from '@nestjs/common';
import { AttendanceService } from './attendance.service';
import { AttendanceController } from './attendance.controller';
import { AuthModule } from '../auth/auth.module';
import { AuditModule } from '../audit/audit.module'; // [출결 이력] AuditService 주입

// [참조/처리] AuthModule import → RolesGuard(AuthService) 주입(로그인 필요 라우트).
@Module({
  imports: [AuthModule, AuditModule],
  controllers: [AttendanceController],
  providers: [AttendanceService],
  exports: [AttendanceService],
})
export class AttendanceModule {}
