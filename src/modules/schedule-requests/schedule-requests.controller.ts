// 강사 수업 요청 → 매니저 승인/반려 (TBO-16 #9).
//  RBAC: 생성·조회·철회=STAFF(강사 포함 — 조회는 강사면 본인 것만 강제), 승인/반려=ADMIN(manager 이상).
import { BadRequestException, Body, Controller, Delete, Get, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import { PositiveIntPipe } from '../../common/positive-int.pipe';
import { ApiBearerAuth, ApiConflictResponse, ApiOperation, ApiParam, ApiQuery, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import type { JwtClaims } from '../auth/auth.service';
import { ScheduleRequestsService } from './schedule-requests.service';
import { CreateScheduleRequestDto } from './dto/create-schedule-request.dto';
import { RejectScheduleRequestDto } from './dto/reject-schedule-request.dto';
import { UpdateScheduleRequestDto } from './dto/update-schedule-request.dto';
import { RolesGuard } from '../auth/roles.guard';
import { Roles, ADMIN_ROLES, STAFF_ROLES } from '../auth/roles.decorator';
import { SessionAccountingImpactConflictResponseDto } from '../schedule/dto/accounting-impact-response.dto';

type AuthedRequest = Request & { user?: JwtClaims };

const isInstructorOnly = (u?: JwtClaims): boolean =>
  !!u && (u.roles ?? []).includes('instructor') && !(u.roles ?? []).some((r) => ADMIN_ROLES.includes(r as never));

const optionalBoolean = (name: string, value?: string): boolean | undefined => {
  if (value == null) return undefined;
  if (value !== 'true' && value !== 'false') throw new BadRequestException(`${name}는 true 또는 false여야 합니다`);
  return value === 'true';
};

@ApiTags('schedule-requests')
@ApiBearerAuth()
@UseGuards(RolesGuard)
@Controller('schedule-requests')
export class ScheduleRequestsController {
  constructor(private readonly requests: ScheduleRequestsService) {}

  @Post()
  @Roles(...STAFF_ROLES) // 강사 포함 — 요청은 누구나(직원), 확정은 관리자
  @ApiOperation({ summary: '요청 생성(pending) — 수업 생성 또는 가용시간 변경 승인 요청. [로그인]' })
  create(@Body() dto: CreateScheduleRequestDto, @Req() req: AuthedRequest) {
    return this.requests.create(dto, req.user!.sub, req.user!.roles);
  }

  @Get()
  @Roles(...STAFF_ROLES)
  @ApiOperation({ summary: '요청 목록(최신순) — 강사는 본인 요청만, 관리자는 전체(status 필터). [로그인]' })
  @ApiQuery({ name: 'status', required: false, enum: ['pending', 'approved', 'rejected'] })
  list(@Req() req: AuthedRequest, @Query('status') status?: 'pending' | 'approved' | 'rejected') {
    // 수평 권한: 강사(관리자 아님)는 requesterId=본인 강제 — 타 강사 요청 열람 차단
    const requesterId = isInstructorOnly(req.user) ? req.user!.sub : undefined;
    return this.requests.list({ status, requesterId });
  }

  @Post(':id/approve')
  @Roles(...ADMIN_ROLES) // manager 이상(#8)
  @ApiParam({ name: 'id' })
  @ApiOperation({ summary: '요청 승인 → 충돌 강제와 회계 영향 확인을 분리하고 원자 전이 + audit. [관리자]' })
  @ApiQuery({ name: 'force', required: false, type: Boolean, deprecated: true, description: '레거시 충돌 강제. 회계 영향 확인에는 사용되지 않음' })
  @ApiQuery({ name: 'forceConflicts', required: false, type: Boolean, description: '시간·자원 충돌 강제 승인' })
  @ApiQuery({ name: 'acknowledgeAccountingImpact', required: false, type: Boolean, description: '409 회계 영향 미리보기 확인' })
  @ApiQuery({ name: 'expectedAccountingImpactHash', required: false, description: '직전 409의 impactHash' })
  @ApiConflictResponse({
    type: SessionAccountingImpactConflictResponseDto,
    description: '시간·자원 충돌 또는 시수·정산 영향 확인/지급 회수 필요.',
  })
  approve(
    @Param('id', PositiveIntPipe) id: number,
    @Req() req: AuthedRequest,
    @Query('force') legacyForce?: string,
    @Query('forceConflicts') forceConflicts?: string,
    @Query('acknowledgeAccountingImpact') acknowledgeAccountingImpact?: string,
    @Query('expectedAccountingImpactHash') expectedAccountingImpactHash?: string,
  ) {
    const legacy = optionalBoolean('force', legacyForce);
    const explicitForce = optionalBoolean('forceConflicts', forceConflicts);
    const acknowledge = optionalBoolean('acknowledgeAccountingImpact', acknowledgeAccountingImpact);
    if (expectedAccountingImpactHash != null && !/^[a-f0-9]{64}$/.test(expectedAccountingImpactHash))
      throw new BadRequestException('expectedAccountingImpactHash는 64자리 sha256 hex여야 합니다');
    return this.requests.approve(id, req.user!.sub, {
      forceConflicts: explicitForce ?? legacy ?? false,
      acknowledgeAccountingImpact: acknowledge ?? false,
      expectedAccountingImpactHash,
    });
  }

  @Patch(':id')
  @Roles(...ADMIN_ROLES)
  @ApiParam({ name: 'id' })
  @ApiOperation({ summary: '[C2C-b] pending 요청 수정(관리자) — 종류·대상 전환 금지, 생성과 동일 검증 재사용, audit update diff. [관리자]' })
  update(@Param('id', PositiveIntPipe) id: number, @Body() dto: UpdateScheduleRequestDto, @Req() req: AuthedRequest) {
    return this.requests.update(id, dto, req.user!.sub);
  }

  @Post(':id/reject')
  @Roles(...ADMIN_ROLES)
  @ApiParam({ name: 'id' })
  @ApiOperation({ summary: '요청 반려 — 사유 필수(Q2). [관리자]' })
  reject(@Param('id', PositiveIntPipe) id: number, @Body() body: RejectScheduleRequestDto, @Req() req: AuthedRequest) {
    return this.requests.reject(id, req.user!.sub, body.reason);
  }

  @Delete(':id')
  @Roles(...STAFF_ROLES)
  @ApiParam({ name: 'id' })
  @ApiOperation({ summary: '본인 pending 요청 철회(soft delete) — 타인 요청 403. [로그인]' })
  withdraw(@Param('id', PositiveIntPipe) id: number, @Req() req: AuthedRequest) {
    return this.requests.withdraw(id, req.user!.sub);
  }
}
