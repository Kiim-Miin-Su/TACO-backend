import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { InstructorContractsService } from './instructor-contracts.service';
import { InstructorContractsController } from './instructor-contracts.controller';
import { AuditModule } from '../audit/audit.module';

// [TBO-19 Sprint4] 강사 계약 모듈. RolesGuard 주입 위해 AuthModule import.
@Module({
  imports: [AuthModule, AuditModule],
  controllers: [InstructorContractsController],
  providers: [InstructorContractsService],
  exports: [InstructorContractsService],
})
export class InstructorContractsModule {}
