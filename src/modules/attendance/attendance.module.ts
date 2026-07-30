import { Module } from '@nestjs/common';
import { AttendanceService } from './attendance.service';
import { AttendanceController } from './attendance.controller';
import { AuthModule } from '../auth/auth.module';
import { AuditModule } from '../audit/audit.module'; // [출결 이력] AuditService 주입
import { CoursesModule } from '../courses/courses.module'; // [TBO-79 B4] 유효 시급 resolver
import { SessionAccountingContextService } from '../schedule/session-accounting-context.service';
import { SessionAccountingGuard } from '../schedule/session-accounting-guard.service';

// [참조/처리] AuthModule import → RolesGuard(AuthService) 주입(로그인 필요 라우트).
@Module({
  imports: [AuthModule, AuditModule, CoursesModule],
  controllers: [AttendanceController],
  // [TBO-79 B4] ScheduleModule이 AttendanceModule을 import하므로 역방향 import는 순환이 된다.
  //  두 서비스 모두 무상태(주입 = 전역 store/CoursesService)라 provider로 직접 선언한다.
  providers: [AttendanceService, SessionAccountingContextService, SessionAccountingGuard],
  exports: [AttendanceService],
})
export class AttendanceModule {}
