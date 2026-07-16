import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module'; // RolesGuard가 AuthService 의존
import { AuditModule } from '../audit/audit.module'; // 쓰기 이력(audit_log)
import { ReportTemplatesController } from './report-templates.controller';
import { ReportTemplatesService } from './report-templates.service';

@Module({ imports: [AuthModule, AuditModule], controllers: [ReportTemplatesController], providers: [ReportTemplatesService] })
export class ReportTemplatesModule {}
