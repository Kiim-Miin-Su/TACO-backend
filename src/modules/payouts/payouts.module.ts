import { Module } from '@nestjs/common';
import { PayoutsService } from './payouts.service';
import { PayoutsController } from './payouts.controller';
import { ReportsModule } from '../reports/reports.module';
import { AuthModule } from '../auth/auth.module';
import { ScheduleModule } from '../schedule/schedule.module';
import { AuditModule } from '../audit/audit.module';

@Module({
  imports: [ReportsModule, AuthModule, ScheduleModule, AuditModule], // [감사 전수 2026-07-16] // ReportsService(시수 적격성) + RolesGuard(AuthService) + class_sessions write-through
  controllers: [PayoutsController],
  providers: [PayoutsService],
  exports: [PayoutsService],
})
export class PayoutsModule {}
