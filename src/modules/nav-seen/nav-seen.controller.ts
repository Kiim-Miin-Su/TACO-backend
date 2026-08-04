// [B3 2026-07-16] 알림 뱃지 읽음 API — 본인 것만 조회/마킹(계정 간 누출 금지 규약).
import { Body, Controller, Get, Put, Req, UnauthorizedException } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { IsIn } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import type { Request } from 'express';
import { Roles, STAFF_ROLES } from '../auth/roles.decorator';
import type { JwtClaims } from '../auth/auth.service';
import { NavSeenService, NAV_KEYS } from './nav-seen.service';

class MarkNavSeenDto {
  @ApiProperty({ enum: NAV_KEYS, example: 'admin', description: '열람 처리할 탭 키' })
  @IsIn(NAV_KEYS as unknown as string[])
  navKey!: string;
}

@ApiTags('nav-seen')
@ApiBearerAuth()
@Controller('nav-seen')
export class NavSeenController {
  constructor(private readonly navSeen: NavSeenService) {}

  private sub(req: Request & { user?: JwtClaims }): number {
    const sub = req.user?.sub;
    if (typeof sub !== 'number') throw new UnauthorizedException('인증 정보가 없습니다.');
    return sub;
  }

  @Get()
  @Roles(...STAFF_ROLES)
  @ApiOperation({ summary: '내 탭별 마지막 열람 시각 — { navKey: lastSeenAtIso } [로그인]' })
  listMine(@Req() req: Request & { user?: JwtClaims }) {
    return this.navSeen.listMine(this.sub(req));
  }

  @Put()
  @Roles(...STAFF_ROLES)
  @ApiOperation({ summary: '탭 진입 열람 마킹(upsert) — 뱃지는 이후 새 활동에만 다시 표시 [로그인]' })
  mark(@Body() dto: MarkNavSeenDto, @Req() req: Request & { user?: JwtClaims }) {
    return this.navSeen.mark(this.sub(req), dto.navKey);
  }
}
