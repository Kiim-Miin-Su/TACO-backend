import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { CatalogController } from './catalog.controller';
import { CountriesService } from './countries.service';

// [E0.5 ④] 참조 데이터 카탈로그(국가·시간대) — 조회 전용 + 검증 서비스 export
//  (ProfileChangeRequestsModule이 countryCode/timeZone 검증에 사용).
@Module({
  imports: [AuthModule],
  controllers: [CatalogController],
  providers: [CountriesService],
  exports: [CountriesService],
})
export class CatalogModule {}
