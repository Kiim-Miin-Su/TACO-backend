import { Module, forwardRef } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { AuditModule } from '../audit/audit.module';
import { UsersService } from './users.service';
import { InstructorHrService } from './instructor-hr.service'; // [TBO-68 C3]
import { SignupApprovalService } from './signup-approval.service'; // [TBO-68 C3]
import { UsersController } from './users.controller';
import { InstructorProfilesStore } from './instructor-profiles.store';
import { InstructorsController } from './instructors.controller';

@Module({
  // [TBO-28B] AuditModule: 승인 tx의 audit_log 기록. 순환(Users→Audit→Auth→Users)은 forwardRef로 해소.
  imports: [forwardRef(() => AuthModule), forwardRef(() => AuditModule)],
  controllers: [UsersController, InstructorsController],
  // [TBO-68 C3] users.service 3분할 — 코어(UsersService)·HR(InstructorHr)·승인(SignupApproval).
  //  SignupApprovalService는 AuthModule(승인센터 라우트)이 소비하므로 export 필수.
  providers: [UsersService, InstructorHrService, SignupApprovalService, InstructorProfilesStore],
  exports: [UsersService, InstructorHrService, SignupApprovalService, InstructorProfilesStore],
})
export class UsersModule {}
