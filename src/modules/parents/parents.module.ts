import { Module } from '@nestjs/common';
import { ParentsService } from './parents.service';
import { ParentsController } from './parents.controller';
import { AuthModule } from '../auth/auth.module';
import { StudentsModule } from '../students/students.module';

// [참조/처리] people 도메인. 서비스가 students 컬렉션을 참조해 studentId FK 검증.
//  [D1] StudentsModule 의존 = init 순서 보장(students 테이블 선생성 → relations FK DO 블록 적용).
@Module({
  imports: [AuthModule, StudentsModule], // RolesGuard(AuthService) 주입 — 생성·연결·관계수정 관리자 전용
  controllers: [ParentsController],
  providers: [ParentsService],
  exports: [ParentsService],
})
export class ParentsModule {}
