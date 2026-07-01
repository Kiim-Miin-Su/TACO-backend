// [참조/처리] 루트 모듈. DatabaseModule(전역 인메모리 DB) + 모든 도메인 feature 모듈을 조립.
//  - 각 feature 모듈 서비스는 onModuleInit에서 시드 → 부팅 시 데이터 준비(프론트가 REST로 하이드레이트).
//  - 관리자 쓰기 모듈(events/expenses/payouts/reports)은 AuthModule을 import해 RolesGuard(AuthService) 주입.
//  - LoggerMiddleware는 전 라우트에 적용(요청 로깅). 컨트롤러 전역 prefix 'api'는 main.ts/서버리스 진입점에서 설정.
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
import { CounselModule } from './modules/counsel/counsel.module';
import { TransactionsModule } from './modules/transactions/transactions.module';
import { EventsModule } from './modules/events/events.module';
import { AttendanceModule } from './modules/attendance/attendance.module';

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
    // 상담(counsel)·원장(transactions)·학원이벤트(events) — B2 목→백엔드 이관
    CounselModule,
    TransactionsModule,
    EventsModule,
    AttendanceModule,
  ],
})
export class AppModule implements NestModule {
  // 모든 요청 로깅(디버깅)
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(LoggerMiddleware).forRoutes('*');
  }
}
