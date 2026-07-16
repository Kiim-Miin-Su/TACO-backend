import { BadRequestException, Injectable, NotFoundException, OnModuleInit } from '@nestjs/common';
import { InMemoryDatabase } from '../../database/in-memory.database';
import { VIEW_PRESETS_SPEC } from '../../database/calendar-asset-specs';
import { PostgresCollectionStore } from '../../database/postgres-collection.store';
import { CalendarUnitOfWork } from '../../database/calendar-unit-of-work.service';
import { AuditService } from '../audit/audit.service';
import { ViewPreset, VIEW_PRESETS } from './view-preset.entity';
import { CreateViewPresetDto } from './dto/create-view-preset.dto';

@Injectable()
export class ViewPresetsService implements OnModuleInit {
  constructor(
    private readonly db: InMemoryDatabase,
    private readonly store: PostgresCollectionStore,
    private readonly uow: CalendarUnitOfWork,
    private readonly audit: AuditService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.store.hydrate<ViewPreset>(VIEW_PRESETS_SPEC);
  }

  async findAll(): Promise<ViewPreset[]> {
    await this.store.hydrate<ViewPreset>(VIEW_PRESETS_SPEC);
    return this.db.findAll<ViewPreset>(VIEW_PRESETS);
  }

  // actorId 없으면(시드·내부 경로) audit 생략. 쓰기+audit 한 tx(uow).
  async create(dto: CreateViewPresetDto, actorId?: number): Promise<ViewPreset> {
    const rows = await this.findAll();
    // 이름 중복 방지(실DB unique(name)와 정합) — 같은 이름 덮어쓰기 대신 명시 삭제 후 재저장 흐름.
    if (rows.some((p) => p.name === dto.name))
      throw new BadRequestException(`같은 이름의 프리셋이 이미 있습니다: ${dto.name}`);
    if (rows.length >= 30)
      throw new BadRequestException('프리셋은 최대 30개까지 저장할 수 있습니다.');
    return this.uow.run(async () => {
      const row = await this.store.insert<ViewPreset>(VIEW_PRESETS_SPEC, { ...dto });
      // [감사 전수 2026-07-16] 전 테이블 CRUD 이력(대표 지시)
      if (actorId != null) await this.audit.log({ entity: 'calendar_view_presets', entityId: row.id, action: 'create', actorId });
      return row;
    });
  }

  async update(id: number, dto: CreateViewPresetDto, actorId?: number): Promise<ViewPreset> {
    const rows = await this.findAll();
    const row = rows.find((preset) => preset.id === id);
    if (!row) throw new NotFoundException(`ViewPreset ${id} not found`);
    const dup = rows.find((p) => p.id !== id && p.name === dto.name);
    if (dup) throw new BadRequestException(`같은 이름의 프리셋이 이미 있습니다: ${dto.name}`);
    const before = { ...row };
    return this.uow.run(async () => {
      const after = (await this.store.update<ViewPreset>(VIEW_PRESETS_SPEC, id, { ...dto })) as ViewPreset;
      // [감사 전수 2026-07-16] 전 테이블 CRUD 이력(대표 지시)
      // diff에 연락처 키 없음 — 방어적 마스킹(users.service maskTarget 규약과 동일 원칙).
      if (actorId != null) {
        await this.audit.log({
          entity: 'calendar_view_presets', entityId: id, action: 'update', actorId,
          changes: this.audit.maskContactPii(this.audit.diffOf(before, after)),
        });
      }
      return after;
    });
  }

  async remove(id: number, actorId?: number): Promise<ViewPreset> {
    const row = (await this.findAll()).find((preset) => preset.id === id);
    if (!row) throw new NotFoundException(`ViewPreset ${id} not found`);
    const before = { ...row };
    return this.uow.run(async () => {
      await this.store.remove(VIEW_PRESETS_SPEC, id, actorId);
      // [감사 전수 2026-07-16] 전 테이블 CRUD 이력(대표 지시)
      if (actorId != null) {
        await this.audit.log({
          entity: 'calendar_view_presets', entityId: id, action: 'delete', actorId,
          changes: this.audit.maskContactPii(this.audit.snapshotOf(before)),
        });
      }
      return before;
    });
  }
}
