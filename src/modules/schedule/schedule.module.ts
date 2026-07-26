import { Module } from '@nestjs/common';
import { RoomsModule } from '../rooms/rooms.module';
import { AvailabilityModule } from '../availability/availability.module';
import { ScheduleService } from './schedule.service';
import { ScheduleReadService } from './schedule-read.service'; // [TBO-69 C1]
import { ScheduleController } from './schedule.controller';
import { AuthModule } from '../auth/auth.module';
import { AuditModule } from '../audit/audit.module';
import { AttendanceModule } from '../attendance/attendance.module';
import { ReportsModule } from '../reports/reports.module';
import { CoursesModule } from '../courses/courses.module';
import { EnrollmentsModule } from '../enrollments/enrollments.module';

// [TBO-29C C1] ClassSessionsStore는 DatabaseModule(@Global)로 이동 — AvailabilityService의
//  잠금 후 세션 권위 재조회가 순환 import 없이 같은 인스턴스를 쓰기 위함.
@Module({
  imports: [RoomsModule, AvailabilityModule, AuthModule, AuditModule, AttendanceModule, ReportsModule, CoursesModule, EnrollmentsModule], // accounting impact도 유효 수업 시급 resolver 사용
  controllers: [ScheduleController],
  providers: [ScheduleService, ScheduleReadService],
  exports: [ScheduleService, ScheduleReadService],
})
export class ScheduleModule {}
