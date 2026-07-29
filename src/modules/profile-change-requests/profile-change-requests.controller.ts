import { Body, Controller, Delete, Get, Param, Post, Req, UnauthorizedException, UseGuards } from '@nestjs/common';
import { PositiveIntPipe } from '../../common/positive-int.pipe';
import { ApiBearerAuth, ApiCreatedResponse, ApiOkResponse, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import type { JwtClaims } from '../auth/auth.service';
import { ADMIN_ROLES, Roles, STAFF_ROLES } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { CreateProfileChangeRequestDto } from './dto/create-profile-change-request.dto';
import { ProfileChangeRequestResponseDto } from './dto/profile-change-request-response.dto';
import { RejectProfileChangeRequestDto } from './dto/reject-profile-change-request.dto';
import { ProfileChangeRequestsService } from './profile-change-requests.service';

type AuthedRequest = Request & { user?: JwtClaims };

@ApiTags('profile-change-requests')
@ApiBearerAuth()
@UseGuards(RolesGuard)
@Controller('profile-change-requests')
export class ProfileChangeRequestsController {
  constructor(private readonly requests: ProfileChangeRequestsService) {}

  @Get('mine')
  @Roles(...STAFF_ROLES)
  @ApiOperation({ summary: '내 프로필 변경 요청 목록. [전 직원]' })
  @ApiOkResponse({ type: ProfileChangeRequestResponseDto, isArray: true })
  mine(@Req() req: AuthedRequest) {
    return this.requests.mine(this.actorOf(req));
  }

  @Post()
  @Roles(...STAFF_ROLES)
  @ApiOperation({ summary: '프로필 변경 요청 생성. 이름·전화·국가·타임존만 허용. [전 직원]' })
  @ApiCreatedResponse({ type: ProfileChangeRequestResponseDto })
  create(@Body() dto: CreateProfileChangeRequestDto, @Req() req: AuthedRequest) {
    return this.requests.create(this.actorOf(req), dto);
  }

  @Get()
  @Roles(...ADMIN_ROLES)
  @ApiOperation({ summary: '전체 프로필 변경 요청 목록. [관리자]' })
  @ApiOkResponse({ type: ProfileChangeRequestResponseDto, isArray: true })
  list() {
    return this.requests.list();
  }

  @Get(':id')
  @Roles(...STAFF_ROLES)
  @ApiParam({ name: 'id' })
  @ApiOperation({ summary: '프로필 변경 요청 상세. 요청자 본인 또는 관리자.' })
  @ApiOkResponse({ type: ProfileChangeRequestResponseDto })
  detail(@Param('id', PositiveIntPipe) id: number, @Req() req: AuthedRequest) {
    return this.requests.detail(id, this.actorOf(req), req.user?.roles);
  }

  @Delete(':id')
  @Roles(...STAFF_ROLES)
  @ApiParam({ name: 'id' })
  @ApiOperation({ summary: '내 pending 프로필 변경 요청 철회(soft delete).' })
  @ApiOkResponse({ description: '{ id, deleted: true }' })
  withdraw(@Param('id', PositiveIntPipe) id: number, @Req() req: AuthedRequest) {
    return this.requests.withdraw(id, this.actorOf(req));
  }

  @Post(':id/approve')
  @Roles(...ADMIN_ROLES)
  @ApiParam({ name: 'id' })
  @ApiOperation({ summary: '프로필 변경 요청 승인. 본인 승인 불가. [관리자]' })
  @ApiCreatedResponse({ type: ProfileChangeRequestResponseDto })
  approve(@Param('id', PositiveIntPipe) id: number, @Req() req: AuthedRequest) {
    return this.requests.approve(id, this.actorOf(req));
  }

  @Post(':id/reject')
  @Roles(...ADMIN_ROLES)
  @ApiParam({ name: 'id' })
  @ApiOperation({ summary: '프로필 변경 요청 반려. 사유 필수, 본인 반려 불가. [관리자]' })
  @ApiCreatedResponse({ type: ProfileChangeRequestResponseDto })
  reject(@Param('id', PositiveIntPipe) id: number, @Body() dto: RejectProfileChangeRequestDto, @Req() req: AuthedRequest) {
    return this.requests.reject(id, this.actorOf(req), dto.reason);
  }

  private actorOf(req: AuthedRequest): number {
    const sub = req.user?.sub;
    if (typeof sub !== 'number') throw new UnauthorizedException('인증 정보가 없습니다.');
    return sub;
  }
}
