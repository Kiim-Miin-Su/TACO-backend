// [참조/처리] 루트 모듈. DatabaseModule(전역 인메모리 DB) + 모든 도메인 feature 모듈을 조립.
//  - 각 feature 모듈 서비스는 onModuleInit에서 시드 → 부팅 시 데이터 준비(프론트가 REST로 하이드레이트).
//  - 관리자 쓰기 모듈(events/expenses/payouts/reports)은 AuthModule을 import해 RolesGuard(AuthService) 주입.
//  - HTTP access log는 main.ts의 LoggingInterceptor가 담당. 컨트롤러 전역 prefix 'api'는 main.ts/서버리스 진입점에서 설정.
import { Module } from '@nestjs/common';
import { AuditModule } from './modules/audit/audit.module';
import { ScheduleRequestsModule } from './modules/schedule-requests/schedule-requests.module';
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
import { ViewPresetsModule } from './modules/view-presets/view-presets.module';
import { ReportTemplatesModule } from './modules/report-templates/report-templates.module';
import { EventsModule } from './modules/events/events.module';
import { InstructorContractsModule } from './modules/instructor-contracts/instructor-contracts.module'; // [TBO-19 Sprint4]
import { AttendanceModule } from './modules/attendance/attendance.module';
import { RoadmapsModule } from './modules/roadmaps/roadmaps.module';
import { ParentsModule } from './modules/parents/parents.module';
import { RegistrationsModule } from './modules/registrations/registrations.module';
import { ProfileChangeRequestsModule } from './modules/profile-change-requests/profile-change-requests.module';
import { ProfileVerificationsModule } from './modules/profile-verifications/profile-verifications.module';

@Module({
  imports: [
    // infrastructure
    DatabaseModule,
    // feature modules
    AuthModule,
    HealthModule,
    UsersModule,
    ProfileChangeRequestsModule,
    ProfileVerificationsModule, // [TBO-29B-4] 연락처 재인증
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
    ScheduleRequestsModule, // TBO-16 #9 — 강사 수업 요청 승인 흐름
    AuditModule, // TBO-16 #7 — 범용 변경 이력
    // 시수 측정·페이 정산(TBO-05)
    ReportsModule,
    PayoutsModule,
    // 상담(counsel)·원장(transactions)·학원이벤트(events) — B2 목→백엔드 이관
    CounselModule,
    TransactionsModule,
    ViewPresetsModule,
    ReportTemplatesModule,
    EventsModule,
    InstructorContractsModule, // [TBO-19 Sprint4] 강사 계약
    AttendanceModule,
    RoadmapsModule,
    ParentsModule,
    RegistrationsModule,
  ],
})
export class AppModule {}
