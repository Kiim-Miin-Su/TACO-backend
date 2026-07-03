import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module'; // RolesGuard가 AuthService 의존
import { ReportTemplatesController } from './report-templates.controller';
import { ReportTemplatesService } from './report-templates.service';

@Module({ imports: [AuthModule], controllers: [ReportTemplatesController], providers: [ReportTemplatesService] })
export class ReportTemplatesModule {}
