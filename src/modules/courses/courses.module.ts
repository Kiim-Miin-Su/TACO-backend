import { Module } from '@nestjs/common';
import { CoursesService } from './courses.service';
import { CoursesController } from './courses.controller';
import { AuthModule } from '../auth/auth.module';
import { AuditModule } from '../audit/audit.module';
import { UsersModule } from '../users/users.module';

@Module({
  imports: [AuthModule, AuditModule, UsersModule], // 강사 profile 기본 시급/Kinder가 course write/read 권위
  controllers: [CoursesController],
  providers: [CoursesService],
  exports: [CoursesService],
})
export class CoursesModule {}
