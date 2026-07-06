// 강사 수업 요청 → 매니저 승인/반려 (TBO-16 #9).
//  RBAC: 생성·조회·철회=STAFF(강사 포함 — 조회는 강사면 본인 것만 강제), 승인/반려=ADMIN(manager 이상).
import { Body, Controller, Delete, Get, Param, ParseIntPipe, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiQuery, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import type { JwtClaims } from '../auth/auth.service';
import { ScheduleRequestsService } from './schedule-requests.service';
import { CreateScheduleRequestDto } from './dto/create-schedule-request.dto';
import { RejectScheduleRequestDto } from './dto/reject-schedule-request.dto';
import { RolesGuard } from '../auth/roles.guard';
import { Roles, ADMIN_ROLES, STAFF_ROLES } from '../auth/roles.decorator';

type AuthedRequest = Request & { user?: JwtClaims };

const isInstructorOnly = (u?: JwtClaims): boolean =>
  !!u && (u.roles ?? []).includes('instructor') && !(u.roles ?? []).some((r) => ADMIN_ROLES.includes(r as never));

@ApiTags('schedule-requests')
@ApiBearerAuth()
@UseGuards(RolesGuard)
@Controller('schedule-requests')
export class ScheduleRequestsController {
  constructor(private readonly requests: ScheduleRequestsService) {}

  @Post()
  @Roles(...STAFF_ROLES) // 강사 포함 — 요청은 누구나(직원), 확정은 관리자
  @ApiOperation({ summary: '수업 요청 생성(pending) — 세션과 동일 FK·코호트 검증 + 참고용 충돌 목록. [로그인]' })
  create(@Body() dto: CreateScheduleRequestDto, @Req() req: AuthedRequest) {
    return this.requests.create(dto, req.user!.sub);
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
  @ApiOperation({ summary: '요청 승인 → createSession 재사용(충돌 409, force=true 강제) + 역참조 + audit. [관리자]' })
  approve(@Param('id', ParseIntPipe) id: number, @Req() req: AuthedRequest, @Query('force') force?: string) {
    return this.requests.approve(id, req.user!.sub, force === 'true');
  }

  @Post(':id/reject')
  @Roles(...ADMIN_ROLES)
  @ApiParam({ name: 'id' })
  @ApiOperation({ summary: '요청 반려 — 사유 필수(Q2). [관리자]' })
  reject(@Param('id', ParseIntPipe) id: number, @Body() body: RejectScheduleRequestDto, @Req() req: AuthedRequest) {
    return this.requests.reject(id, req.user!.sub, body.reason);
  }

  @Delete(':id')
  @Roles(...STAFF_ROLES)
  @ApiParam({ name: 'id' })
  @ApiOperation({ summary: '본인 pending 요청 철회(soft delete) — 타인 요청 403. [로그인]' })
  withdraw(@Param('id', ParseIntPipe) id: number, @Req() req: AuthedRequest) {
    return this.requests.withdraw(id, req.user!.sub);
  }
}
