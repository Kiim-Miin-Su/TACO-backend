import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { AuditModule } from '../audit/audit.module';
import { ScheduleModule } from '../schedule/schedule.module';
import { StaffAttendanceController } from './staff-attendance.controller';
import { StaffAttendanceService } from './staff-attendance.service';

@Module({
  imports: [AuthModule, AuditModule, ScheduleModule],
  controllers: [StaffAttendanceController],
  providers: [StaffAttendanceService],
  exports: [StaffAttendanceService],
})
export class StaffAttendanceModule {}

