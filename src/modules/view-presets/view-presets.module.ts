import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module'; // RolesGuard가 AuthService 의존
import { ViewPresetsController } from './view-presets.controller';
import { ViewPresetsService } from './view-presets.service';

@Module({ imports: [AuthModule], controllers: [ViewPresetsController], providers: [ViewPresetsService] })
export class ViewPresetsModule {}
