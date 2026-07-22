import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { PostgresConnectionService } from '../../database/postgres-connection.service';
import { Public } from '../auth/public.decorator';

@ApiTags('health')
@Public()
@Controller('health')
export class HealthController {
  constructor(private readonly postgres: PostgresConnectionService) {}

  @Get()
  @ApiOperation({ summary: 'API health check' })
  check() {
    return { status: 'ok', service: 'taco-api', ts: new Date().toISOString() };
  }

  @Get('db')
  @ApiOperation({ summary: '운영 Postgres 연결 및 영속 저장소 준비 상태 확인' })
  async database() {
    const db = await this.postgres.ping();
    return {
      status: db.configured && !db.ready ? 'degraded' : 'ok',
      service: 'taco-api',
      ts: new Date().toISOString(),
      db: {
        runtimeStore: db.runtimeStore,
        configured: db.configured,
        ready: db.ready,
        ...(db.latencyMs != null ? { latencyMs: db.latencyMs } : {}),
      },
    };
  }
}
