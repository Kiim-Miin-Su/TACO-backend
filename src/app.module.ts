import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { LoggerMiddleware } from './common/logger.middleware';
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
import { ReportsModule } from './modules/reports/reports.module';
import { PayoutsModule } from './modules/payouts/payouts.module';

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
    // 시수 측정·페이 정산(TBO-05)
    ReportsModule,
    PayoutsModule,
  ],
})
export class AppModule implements NestModule {
  // 모든 요청 로깅(디버깅)
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(LoggerMiddleware).forRoutes('*');
  }
}
