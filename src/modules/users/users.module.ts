import { Module, forwardRef } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { AuditModule } from '../audit/audit.module';
import { UsersService } from './users.service';
import { UsersController } from './users.controller';
import { InstructorProfilesStore } from './instructor-profiles.store';
import { InstructorsController } from './instructors.controller';

@Module({
  // [TBO-28B] AuditModule: 승인 tx의 audit_log 기록. 순환(Users→Audit→Auth→Users)은 forwardRef로 해소.
  imports: [forwardRef(() => AuthModule), forwardRef(() => AuditModule)],
  controllers: [UsersController, InstructorsController],
  providers: [UsersService, InstructorProfilesStore],
  exports: [UsersService, InstructorProfilesStore],
})
export class UsersModule {}
