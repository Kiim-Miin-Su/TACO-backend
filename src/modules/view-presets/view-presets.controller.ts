import { Body, Controller, Delete, Get, Param, ParseIntPipe, Patch, Post, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { ViewPresetsService } from './view-presets.service';
import { CreateViewPresetDto } from './dto/create-view-preset.dto';
import { RolesGuard } from '../auth/roles.guard';
import { Roles, STAFF_ROLES } from '../auth/roles.decorator';

// [참조/처리] /api/view-presets — 캘린더 뷰 프리셋(직원 공용 자산). 읽기·쓰기 모두 로그인 직원.
@ApiTags('view-presets')
@UseGuards(RolesGuard)
@Controller('view-presets')
export class ViewPresetsController {
  constructor(private readonly presets: ViewPresetsService) {}

  @Get()
  @Roles(...STAFF_ROLES)
  findAll() {
    return this.presets.findAll();
  }

  @Post()
  @Roles(...STAFF_ROLES)
  create(@Body() dto: CreateViewPresetDto) {
    return this.presets.create(dto);
  }

  @Patch(':id')
  @Roles(...STAFF_ROLES)
  update(@Param('id', ParseIntPipe) id: number, @Body() dto: CreateViewPresetDto) {
    return this.presets.update(id, dto);
  }

  @Delete(':id')
  @Roles(...STAFF_ROLES)
  remove(@Param('id', ParseIntPipe) id: number) {
    return this.presets.remove(id);
  }
}
