import { Module } from '@nestjs/common';
import { ParentsService } from './parents.service';
import { ParentsController } from './parents.controller';
import { AuthModule } from '../auth/auth.module';

// [참조/처리] people 도메인(무가드). 서비스가 students 컬렉션을 참조해 studentId FK 검증.
@Module({
  imports: [AuthModule], // RolesGuard(AuthService) 주입 — 생성·연결·관계수정 관리자 전용
  controllers: [ParentsController],
  providers: [ParentsService],
  exports: [ParentsService],
})
export class ParentsModule {}
