import { Body, Controller, Delete, Get, Param, ParseIntPipe, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { ViewPresetsService } from './view-presets.service';
import { CreateViewPresetDto } from './dto/create-view-preset.dto';
import { RolesGuard } from '../auth/roles.guard';
import { Roles, STAFF_ROLES } from '../auth/roles.decorator';
import type { JwtClaims } from '../auth/auth.service';

// [참조/처리] /api/view-presets — 캘린더 뷰 프리셋(직원 공용 자산). 읽기·쓰기 모두 로그인 직원.
@ApiTags('view-presets')
@UseGuards(RolesGuard)
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
  @ApiOperation({ summary: '캘린더 뷰 프리셋 수정 [전 직원]' })
  update(@Param('id', ParseIntPipe) id: number, @Body() dto: CreateViewPresetDto, @Req() req: Request & { user?: JwtClaims }) {
    return this.presets.update(id, dto, req.user?.sub);
  }

  @Delete(':id')
  @Roles(...STAFF_ROLES)
  @ApiOperation({ summary: '캘린더 뷰 프리셋 soft delete [전 직원]' })
  remove(@Param('id', ParseIntPipe) id: number, @Req() req: Request & { user?: JwtClaims }) {
    return this.presets.remove(id, req.user?.sub);
  }
}
