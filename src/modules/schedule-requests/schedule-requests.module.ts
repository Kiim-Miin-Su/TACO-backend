import { Module } from '@nestjs/common';
import { ScheduleRequestsService } from './schedule-requests.service';
import { ScheduleRequestsStore } from './schedule-requests.store';
import { ScheduleRequestsController } from './schedule-requests.controller';
import { AuthModule } from '../auth/auth.module';
import { ScheduleModule } from '../schedule/schedule.module';
import { AuditModule } from '../audit/audit.module';
import { AvailabilityModule } from '../availability/availability.module';

@Module({
  imports: [AuthModule, ScheduleModule, AvailabilityModule, AuditModule], // RolesGuard + createSession/availability 재사용 + 이력
  controllers: [ScheduleRequestsController],
  providers: [ScheduleRequestsService, ScheduleRequestsStore],
  exports: [ScheduleRequestsService],
})
export class ScheduleRequestsModule {}
