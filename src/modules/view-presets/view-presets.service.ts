import { BadRequestException, Injectable, NotFoundException, OnModuleInit } from '@nestjs/common';
import { InMemoryDatabase } from '../../database/in-memory.database';
import { VIEW_PRESETS_SPEC } from '../../database/calendar-asset-specs';
import { PostgresCollectionStore } from '../../database/postgres-collection.store';
import { ViewPreset, VIEW_PRESETS } from './view-preset.entity';
import { CreateViewPresetDto } from './dto/create-view-preset.dto';

@Injectable()
export class ViewPresetsService implements OnModuleInit {
  constructor(
    private readonly db: InMemoryDatabase,
    private readonly store: PostgresCollectionStore,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.store.hydrate<ViewPreset>(VIEW_PRESETS_SPEC);
  }

  findAll(): ViewPreset[] {
    return this.db.findAll<ViewPreset>(VIEW_PRESETS);
  }

  create(dto: CreateViewPresetDto): Promise<ViewPreset> {
    // 이름 중복 방지(실DB unique(name)와 정합) — 같은 이름 덮어쓰기 대신 명시 삭제 후 재저장 흐름.
    if (this.findAll().some((p) => p.name === dto.name))
      throw new BadRequestException(`같은 이름의 프리셋이 이미 있습니다: ${dto.name}`);
    if (this.findAll().length >= 30)
      throw new BadRequestException('프리셋은 최대 30개까지 저장할 수 있습니다.');
    return this.store.insert<ViewPreset>(VIEW_PRESETS_SPEC, { ...dto });
  }

  update(id: number, dto: CreateViewPresetDto): Promise<ViewPreset> {
    const row = this.db.findById<ViewPreset>(VIEW_PRESETS, id);
    if (!row) throw new NotFoundException(`ViewPreset ${id} not found`);
    const dup = this.findAll().find((p) => p.id !== id && p.name === dto.name);
    if (dup) throw new BadRequestException(`같은 이름의 프리셋이 이미 있습니다: ${dto.name}`);
    return this.store.update<ViewPreset>(VIEW_PRESETS_SPEC, id, { ...dto }) as Promise<ViewPreset>;
  }

  async remove(id: number): Promise<ViewPreset> {
    const row = this.db.findById<ViewPreset>(VIEW_PRESETS, id);
    if (!row) throw new NotFoundException(`ViewPreset ${id} not found`);
    await this.store.remove(VIEW_PRESETS_SPEC, id);
    return row;
  }
}
