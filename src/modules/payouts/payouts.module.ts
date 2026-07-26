import { Module } from '@nestjs/common';
import { PayoutsService } from './payouts.service';
import { PayoutsReadService } from './payouts-read.service'; // [TBO-69 C2]
import { PayoutsController } from './payouts.controller';
import { ReportsModule } from '../reports/reports.module';
import { AuthModule } from '../auth/auth.module';
import { ScheduleModule } from '../schedule/schedule.module';
import { AuditModule } from '../audit/audit.module';
import { CoursesModule } from '../courses/courses.module';
import { PayoutReadinessService } from './payout-readiness.service';

@Module({
  imports: [ReportsModule, AuthModule, ScheduleModule, AuditModule, CoursesModule], // 유효 시급은 CoursesService resolver 단일 소스
  controllers: [PayoutsController],
  providers: [PayoutsService, PayoutsReadService, PayoutReadinessService],
  exports: [PayoutsService, PayoutsReadService, PayoutReadinessService],
})
export class PayoutsModule {}
