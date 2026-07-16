import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module'; // RolesGuard가 AuthService 의존
import { AuditModule } from '../audit/audit.module'; // 쓰기 이력(audit_log)
import { ViewPresetsController } from './view-presets.controller';
import { ViewPresetsService } from './view-presets.service';

@Module({ imports: [AuthModule, AuditModule], controllers: [ViewPresetsController], providers: [ViewPresetsService] })
export class ViewPresetsModule {}
