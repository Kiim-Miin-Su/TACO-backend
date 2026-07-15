import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { StudentsModule } from '../students/students.module';
import { ParentsModule } from '../parents/parents.module';
import { EnrollmentsModule } from '../enrollments/enrollments.module';
import { AuditModule } from '../audit/audit.module';
import { RegistrationsService } from './registrations.service';
import { RegistrationsController } from './registrations.controller';

// [TBO-29D D2] 학생 aggregate 등록 — Students↔Parents 순환 의존을 피하려고 상위 조합 모듈로 분리.
@Module({
  imports: [AuthModule, StudentsModule, ParentsModule, EnrollmentsModule, AuditModule],
  controllers: [RegistrationsController],
  providers: [RegistrationsService],
})
export class RegistrationsModule {}
