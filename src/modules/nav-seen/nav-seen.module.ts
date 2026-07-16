import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { NavSeenController } from './nav-seen.controller';
import { NavSeenService } from './nav-seen.service';

// [B3 2026-07-16] 알림 뱃지 읽음 상태 — 사용자×탭 last-seen 자산.
@Module({
  imports: [AuthModule],
  controllers: [NavSeenController],
  providers: [NavSeenService],
  exports: [NavSeenService],
})
export class NavSeenModule {}
