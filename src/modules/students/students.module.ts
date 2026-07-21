import { Module } from '@nestjs/common';
import { StudentsService } from './students.service';
import { StudentsController } from './students.controller';
import { AuthModule } from '../auth/auth.module';
import { AuditModule } from '../audit/audit.module';
import { CoursesModule } from '../courses/courses.module';
import { StudentInterestsService } from './student-interests.service';
import { StudentInterestsController } from './student-interests.controller';

@Module({
  imports: [AuthModule, AuditModule, CoursesModule], // CoursesModule=student_interests course FK/활성 참조의 init 권위
  controllers: [StudentsController, StudentInterestsController],
  providers: [StudentsService, StudentInterestsService],
  exports: [StudentsService, StudentInterestsService],
})
export class StudentsModule {}
