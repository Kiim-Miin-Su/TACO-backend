import { Body, Controller, Delete, Get, Param, Patch, Post, Req } from '@nestjs/common';
import { PositiveIntPipe } from '../../common/positive-int.pipe';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { ViewPresetsService } from './view-presets.service';
import { CreateViewPresetDto } from './dto/create-view-preset.dto';
import { Roles, STAFF_ROLES } from '../auth/roles.decorator';
import type { JwtClaims } from '../auth/auth.service';

// [참조/처리] /api/view-presets — 캘린더 뷰 프리셋(직원 공용 자산). 읽기·쓰기 모두 로그인 직원.
@ApiTags('view-presets')
@Controller('view-presets')
export class ViewPresetsController {
  constructor(private readonly presets: ViewPresetsService) {}

  @Get()
  @Roles(...STAFF_ROLES)
  @ApiOperation({ summary: '캘린더 뷰 프리셋 목록 조회 [전 직원]' })
  findAll() {
    return this.presets.findAll();
  }

  @Post()
  @Roles(...STAFF_ROLES)
  @ApiOperation({ summary: '캘린더 뷰 프리셋 생성 [전 직원]' })
  create(@Body() dto: CreateViewPresetDto, @Req() req: Request & { user?: JwtClaims }) {
    return this.presets.create(dto, req.user?.sub);
  }

  @Patch(':id')
  @Roles(...STAFF_ROLES)
  @ApiOperation({ summary: '캘린더 뷰 프리셋 수정 [소유자·매니저 이상]' })
  update(@Param('id', PositiveIntPipe) id: number, @Body() dto: CreateViewPresetDto, @Req() req: Request & { user?: JwtClaims }) {
    return this.presets.update(id, dto, req.user?.sub, req.user?.roles); // [TBO-58 P2] IDOR 가드
  }

  @Delete(':id')
  @Roles(...STAFF_ROLES)
  @ApiOperation({ summary: '캘린더 뷰 프리셋 soft delete [소유자·매니저 이상]' })
  remove(@Param('id', PositiveIntPipe) id: number, @Req() req: Request & { user?: JwtClaims }) {
    return this.presets.remove(id, req.user?.sub, req.user?.roles); // [TBO-58 P2] IDOR 가드
  }
}
