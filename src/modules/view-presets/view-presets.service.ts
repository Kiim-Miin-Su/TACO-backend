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

  async findAll(): Promise<ViewPreset[]> {
    await this.store.hydrate<ViewPreset>(VIEW_PRESETS_SPEC);
    return this.db.findAll<ViewPreset>(VIEW_PRESETS);
  }

  async create(dto: CreateViewPresetDto): Promise<ViewPreset> {
    const rows = await this.findAll();
    // 이름 중복 방지(실DB unique(name)와 정합) — 같은 이름 덮어쓰기 대신 명시 삭제 후 재저장 흐름.
    if (rows.some((p) => p.name === dto.name))
      throw new BadRequestException(`같은 이름의 프리셋이 이미 있습니다: ${dto.name}`);
    if (rows.length >= 30)
      throw new BadRequestException('프리셋은 최대 30개까지 저장할 수 있습니다.');
    return this.store.insert<ViewPreset>(VIEW_PRESETS_SPEC, { ...dto });
  }

  async update(id: number, dto: CreateViewPresetDto): Promise<ViewPreset> {
    const rows = await this.findAll();
    const row = rows.find((preset) => preset.id === id);
    if (!row) throw new NotFoundException(`ViewPreset ${id} not found`);
    const dup = rows.find((p) => p.id !== id && p.name === dto.name);
    if (dup) throw new BadRequestException(`같은 이름의 프리셋이 이미 있습니다: ${dto.name}`);
    return this.store.update<ViewPreset>(VIEW_PRESETS_SPEC, id, { ...dto }) as Promise<ViewPreset>;
  }

  async remove(id: number): Promise<ViewPreset> {
    const row = (await this.findAll()).find((preset) => preset.id === id);
    if (!row) throw new NotFoundException(`ViewPreset ${id} not found`);
    await this.store.remove(VIEW_PRESETS_SPEC, id);
    return row;
  }
}
