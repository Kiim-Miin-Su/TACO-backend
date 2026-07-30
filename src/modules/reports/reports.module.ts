import { Module } from '@nestjs/common';
import { ReportsService } from './reports.service';
import { ReportsController } from './reports.controller';
import { AuthModule } from '../auth/auth.module';
import { AuditModule } from '../audit/audit.module';
import { CoursesModule } from '../courses/courses.module'; // [TBO-79 B5] 유효 시급 resolver
import { SessionAccountingContextService } from '../schedule/session-accounting-context.service';
import { SessionAccountingGuard } from '../schedule/session-accounting-guard.service';

@Module({
  imports: [AuthModule, AuditModule, CoursesModule], // [감사 전수 2026-07-16] // RolesGuard(AuthService) 주입
  controllers: [ReportsController],
  // [TBO-79 B5] ScheduleModule이 ReportsModule을 import하므로 역방향은 순환 — 무상태 서비스를 직접 선언.
  providers: [ReportsService, SessionAccountingContextService, SessionAccountingGuard],
  exports: [ReportsService],
})
export class ReportsModule {}
