import { Module } from '@nestjs/common';
import { RoomsModule } from '../rooms/rooms.module';
import { AvailabilityModule } from '../availability/availability.module';
import { ScheduleService } from './schedule.service';
import { ScheduleController } from './schedule.controller';
import { AuthModule } from '../auth/auth.module';
import { AuditModule } from '../audit/audit.module';
import { AttendanceModule } from '../attendance/attendance.module';
import { ReportsModule } from '../reports/reports.module';
import { ClassSessionsStore } from './class-sessions.store';

@Module({
  imports: [RoomsModule, AvailabilityModule, AuthModule, AuditModule, AttendanceModule, ReportsModule], // join·충돌 + RolesGuard + 변경 이력
  controllers: [ScheduleController],
  providers: [ScheduleService, ClassSessionsStore],
  exports: [ScheduleService],
})
export class ScheduleModule {}
