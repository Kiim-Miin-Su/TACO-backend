import { Module } from '@nestjs/common';
import { ScheduleRequestsService } from './schedule-requests.service';
import { ScheduleRequestsController } from './schedule-requests.controller';
import { AuthModule } from '../auth/auth.module';
import { ScheduleModule } from '../schedule/schedule.module';
import { AuditModule } from '../audit/audit.module';

@Module({
  imports: [AuthModule, ScheduleModule, AuditModule], // RolesGuard + createSession 재사용 + 이력
  controllers: [ScheduleRequestsController],
  providers: [ScheduleRequestsService],
  exports: [ScheduleRequestsService],
})
export class ScheduleRequestsModule {}
