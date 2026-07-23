// [TBO-46 G1 2026-07-23] GraphQL 게이트웨이 모듈 — 읽기 전용, 기존 서비스·순수 함수 소비만.
import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { CounselModule } from '../counsel/counsel.module';
import { PayoutsModule } from '../payouts/payouts.module';
import { GraphqlGatewayController } from './graphql.controller';

@Module({
  imports: [AuthModule, CounselModule, PayoutsModule],
  controllers: [GraphqlGatewayController],
})
export class GraphqlGatewayModule {}
