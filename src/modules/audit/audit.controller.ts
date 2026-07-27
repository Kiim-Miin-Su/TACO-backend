// 변경 이력 조회 — ADMIN 전용(changes에 개인정보 스냅샷 가능 → 최소 노출 원칙).
import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { AuditService } from './audit.service';
import { RolesGuard } from '../auth/roles.guard';
import { Roles, ADMIN_ROLES } from '../auth/roles.decorator';
import {
  OptionalBoundedIntPipe,
  OptionalPositiveIntPipe,
} from '../../common/positive-int.pipe';

const OPTIONAL_AUDIT_LIMIT = new OptionalBoundedIntPipe(1, 500, 'limit');

@ApiTags('audit')
@UseGuards(RolesGuard)
@Controller('audit')
export class AuditController {
  constructor(private readonly audit: AuditService) {}

  @Get()
  @Roles(...ADMIN_ROLES) // 관리자 전용 — 이력에 before/after 스냅샷(개인정보 가능) 포함
  @ApiOperation({ summary: '변경 이력 조회(최신순, 기본 200건) — entity/entityId/actorId 필터.' })
  list(
    @Query('entity') entity?: string,
    @Query('entityId', OptionalPositiveIntPipe) entityId?: number,
    @Query('actorId', OptionalPositiveIntPipe) actorId?: number,
    @Query('limit', OPTIONAL_AUDIT_LIMIT) limit?: number,
  ) {
    return this.audit.list({
      entity,
      entityId,
      actorId,
      limit,
    });
  }
}
