import { Module } from '@nestjs/common';
import { DatabaseModule } from './database/database.module';
import { AuthModule } from './modules/auth/auth.module';
import { HealthModule } from './modules/health/health.module';
import { UsersModule } from './modules/users/users.module';
import { StudentsModule } from './modules/students/students.module';
import { EnrollmentsModule } from './modules/enrollments/enrollments.module';
import { PaymentsModule } from './modules/payments/payments.module';
import { SubjectsModule } from './modules/subjects/subjects.module';
import { CoursesModule } from './modules/courses/courses.module';
import { ExpensesModule } from './modules/expenses/expenses.module';
import { RoomsModule } from './modules/rooms/rooms.module';
import { AvailabilityModule } from './modules/availability/availability.module';
import { ScheduleModule } from './modules/schedule/schedule.module';

@Module({
  imports: [
    // infrastructure
    DatabaseModule,
    // feature modules
    AuthModule,
    HealthModule,
    UsersModule,
    StudentsModule,
    EnrollmentsModule,
    PaymentsModule,
    SubjectsModule,
    CoursesModule,
    ExpensesModule,
    // 스케줄(v5)
    RoomsModule,
    AvailabilityModule,
    ScheduleModule,
  ],
})
export class AppModule {}
