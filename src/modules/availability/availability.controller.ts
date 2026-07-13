import { Body, Controller, Delete, ForbiddenException, Get, Param, ParseIntPipe, Post, Put, Query, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import type { JwtClaims } from '../auth/auth.service';
import { ApiTags, ApiOperation, ApiQuery, ApiParam, ApiOkResponse, ApiConflictResponse, ApiBadRequestResponse } from '@nestjs/swagger';
import { AvailabilityService } from './availability.service';
import { AvailabilityOwner } from './availability.entity';
import { UpsertAvailabilityDto } from './dto/upsert-availability.dto';
import { RolesGuard } from '../auth/roles.guard';
import { isInstructorOnly, Roles, STAFF_ROLES } from '../auth/roles.decorator';

@ApiTags('availability')
@UseGuards(RolesGuard)
@Controller('availability')
export class AvailabilityController {
  constructor(private readonly availability: AvailabilityService) {}

  @Get()
  @Roles(...STAFF_ROLES) // [보안 2026-07-03] 사내 데이터 조회 — 로그인 필수
  @ApiOperation({ summary: '가용/불가 블록 목록(ownerType·ownerId 필터). 강사는 쿼리와 무관하게 본인 블록만 조회.' })
  @ApiQuery({ name: 'ownerType', required: false, enum: ['student', 'instructor', 'room'] })
  @ApiQuery({ name: 'ownerId', required: false })
  @ApiOkResponse({ description: 'AvailabilityBlock[] — { id, ownerType, ownerId, kind, weekday, startTime, endTime }' })
  async list(
    @Req() req: Request & { user?: JwtClaims },
    @Query('ownerType') ownerType?: AvailabilityOwner,
    @Query('ownerId') ownerId?: string,
  ) {
    await this.availability.refresh();
    if (isInstructorOnly(req.user?.roles)) {
      return this.availability.list('instructor', req.user!.sub);
    }
    return this.availability.list(ownerType, ownerId ? Number(ownerId) : undefined);
  }

  @Put()
  @Roles(...STAFF_ROLES)
  @ApiOperation({ summary: '가용/불가 블록 생성·수정(id 있으면 수정). 같은 오너·요일 겹침 시 409.' })
  @ApiOkResponse({ description: 'AvailabilityBlock(생성/수정 결과)' })
  @ApiConflictResponse({ description: '이미 지정된 가용/불가 시간과 겹침(겹친 시각 메시지 포함)' })
  @ApiBadRequestResponse({ description: '존재하지 않는 강의실 owner 등' })
  upsert(@Body() dto: UpsertAvailabilityDto, @Req() req: Request & { user?: JwtClaims }) {
    return this.availability.upsert(dto, req.user?.sub, req.user?.roles); // actor → audit_log(Q3)
  }

  @Post('impact')
  @Roles(...STAFF_ROLES)
  @ApiOperation({ summary: '가용/불가 변경 영향 미리보기 — 강사는 본인 블록만, 기존 수업 침범 시 승인 요청 모달용' })
  @ApiOkResponse({ description: '{ impactedSessions: AvailabilityImpact[] }' })
  async impact(@Body() dto: UpsertAvailabilityDto, @Req() req: Request & { user?: JwtClaims }) {
    if (isInstructorOnly(req.user?.roles) && (dto.ownerType !== 'instructor' || dto.ownerId !== req.user!.sub)) {
      throw new ForbiddenException('강사는 본인 가용시간의 영향만 조회할 수 있습니다.');
    }
    await this.availability.refresh();
    return { impactedSessions: this.availability.previewUpsertImpact(dto) };
  }

  @Delete(':id')
  @Roles(...STAFF_ROLES)
  @ApiParam({ name: 'id', description: '블록 id' })
  @ApiOperation({ summary: '가용/불가 블록 삭제' })
  @ApiOkResponse({ description: '{ id, deleted: boolean }' })
  remove(@Param('id', ParseIntPipe) id: number, @Req() req: Request & { user?: JwtClaims }) {
    return this.availability.remove(id, req.user?.sub, req.user?.roles); // actor → soft delete + audit
  }
}
