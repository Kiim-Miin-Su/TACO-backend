import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InMemoryDatabase } from '../../database/in-memory.database';
import { ViewPreset, VIEW_PRESETS } from './view-preset.entity';
import { CreateViewPresetDto } from './dto/create-view-preset.dto';

@Injectable()
export class ViewPresetsService {
  constructor(private readonly db: InMemoryDatabase) {}

  findAll(): ViewPreset[] {
    return this.db.findAll<ViewPreset>(VIEW_PRESETS);
  }

  create(dto: CreateViewPresetDto): ViewPreset {
    // 이름 중복 방지(실DB unique(name)와 정합) — 같은 이름 덮어쓰기 대신 명시 삭제 후 재저장 흐름.
    if (this.findAll().some((p) => p.name === dto.name))
      throw new BadRequestException(`같은 이름의 프리셋이 이미 있습니다: ${dto.name}`);
    if (this.findAll().length >= 30)
      throw new BadRequestException('프리셋은 최대 30개까지 저장할 수 있습니다.');
    return this.db.insert<ViewPreset>(VIEW_PRESETS, { ...dto });
  }

  remove(id: number): ViewPreset {
    const row = this.db.findById<ViewPreset>(VIEW_PRESETS, id);
    if (!row) throw new NotFoundException(`ViewPreset ${id} not found`);
    this.db.remove(VIEW_PRESETS, id);
    return row;
  }
}
