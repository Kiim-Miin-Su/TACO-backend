import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module'; // RolesGuard가 AuthService 의존
import { AuditModule } from '../audit/audit.module'; // 쓰기 이력(audit_log)
import { ReportTemplatesController } from './report-templates.controller';
import { ReportTemplatesService } from './report-templates.service';
import { DatabaseModule } from '../../database/database.module';

@Module({ imports: [AuthModule, AuditModule, DatabaseModule], controllers: [ReportTemplatesController], providers: [ReportTemplatesService] })
export class ReportTemplatesModule {}
