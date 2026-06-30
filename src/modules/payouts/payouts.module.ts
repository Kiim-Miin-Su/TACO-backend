import { Module } from '@nestjs/common';
import { PayoutsService } from './payouts.service';
import { PayoutsController } from './payouts.controller';
import { ReportsModule } from '../reports/reports.module';

@Module({
  imports: [ReportsModule], // 시수 적격성(승인 보고서) 판정에 ReportsService 사용
  controllers: [PayoutsController],
  providers: [PayoutsService],
  exports: [PayoutsService],
})
export class PayoutsModule {}
