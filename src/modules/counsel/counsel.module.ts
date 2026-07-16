import { Module } from '@nestjs/common';
import { CounselService } from './counsel.service';
import { CounselController } from './counsel.controller';
import { AuthModule } from '../auth/auth.module';
import { AuditModule } from '../audit/audit.module';

// [참조/처리] AuthModule import → RolesGuard(AuthService) 주입(쓰기 로그인 필수). AuditModule=쓰기 이력.
@Module({
  imports: [AuthModule, AuditModule],
  controllers: [CounselController],
  providers: [CounselService],
  exports: [CounselService],
})
export class CounselModule {}
