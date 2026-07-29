import { BadRequestException, ForbiddenException, Injectable, NotFoundException, OnModuleInit } from '@nestjs/common';
import { InMemoryDatabase } from '../../database/in-memory.database';
import { CalendarUnitOfWork } from '../../database/calendar-unit-of-work.service';
import { AuditService } from '../audit/audit.service';
import { ReportTemplate, REPORT_TEMPLATES } from './report-template.entity';
import { CreateReportTemplateDto } from './dto/create-report-template.dto';
import { UpdateReportTemplateDto } from './dto/update-report-template.dto';
import { PostgresCollectionStore } from '../../database/postgres-collection.store';
import { REPORT_TEMPLATES_SPEC } from '../../database/calendar-asset-specs';
import { hasAdminRole } from '../auth/role-policy';

@Injectable()
export class ReportTemplatesService implements OnModuleInit {
  constructor(
    private readonly db: InMemoryDatabase,
    private readonly store: PostgresCollectionStore,
    private readonly uow: CalendarUnitOfWork,
    private readonly audit: AuditService,
  ) {}

  // 시드 = 기존 zustand 기본 템플릿 2건 이관(자산화 — 프론트 하드코딩 제거)
  async onModuleInit(): Promise<void> {
    const templates = await this.store.hydrate<ReportTemplate>(REPORT_TEMPLATES_SPEC);
    if (templates.length) return;
    await this.store.seedReference<ReportTemplate>(REPORT_TEMPLATES_SPEC, [
      { id: 1, name: '정규 수업(기본)', content: '오늘 학습 내용: \n이해도: 상/중/하\n특이사항: ', homework: '교재 p.   ~   풀이' },
      { id: 2, name: '시험 대비', content: '대비 범위: \n취약 단원: \n보강 권장: ', homework: '오답노트 정리' },
    ]);
  }

  findAll(): ReportTemplate[] {
    return this.db.findAll<ReportTemplate>(REPORT_TEMPLATES);
  }

  /** [TBO-56 C2b] 목록 READ = DB 권위. */
  listDb(): Promise<ReportTemplate[]> {
    return this.store.findActive<ReportTemplate>(REPORT_TEMPLATES_SPEC, { orderBy: { field: 'id' } });
  }

  private assertCanMutate(row: ReportTemplate, actorId?: number, actorRoles?: string[]): void {
    if (hasAdminRole(actorRoles)) return;
    if (row.createdBy != null && actorId != null && row.createdBy === actorId) return;
    throw new ForbiddenException('본인이 만든 템플릿만 수정/삭제할 수 있습니다(기본 템플릿은 매니저 이상).');
  }

  private async findActiveById(id: number): Promise<ReportTemplate> {
    const [row] = await this.store.findActive<ReportTemplate>(
      REPORT_TEMPLATES_SPEC,
      { where: { id } as Partial<ReportTemplate>, limit: 1 },
    );
    if (!row) throw new NotFoundException(`ReportTemplate ${id} not found`);
    return row;
  }

  // actorId 없으면(시드·내부 경로) audit 생략. 쓰기+audit 한 tx(uow).
  async create(dto: CreateReportTemplateDto, actorId?: number): Promise<ReportTemplate> {
    return this.uow.run(async () => {
      // [TBO-56 C2b] 이름 중복 판별 = DB 기준(활성 unique가 최후 방어)
      const dup = await this.store.findActive<ReportTemplate>(REPORT_TEMPLATES_SPEC, { where: { name: dto.name } as Partial<ReportTemplate>, limit: 1 });
      if (dup.length) throw new BadRequestException(`같은 이름의 템플릿이 이미 있습니다: ${dto.name}`);
      const row = await this.store.insert<ReportTemplate>(
        REPORT_TEMPLATES_SPEC,
        { ...dto, createdBy: actorId ?? null },
      );
      // [감사 전수 2026-07-16] 전 테이블 CRUD 이력(대표 지시)
      if (actorId != null) await this.audit.log({ entity: 'report_templates', entityId: row.id, action: 'create', actorId });
      return row;
    });
  }

  async update(
    id: number,
    dto: UpdateReportTemplateDto,
    actorId?: number,
    actorRoles?: string[],
  ): Promise<ReportTemplate> {
    return this.uow.run(async () => {
      await this.uow.lockTargets([{ kind: 'reportTemplate', id }]);
      const row = await this.findActiveById(id);
      this.assertCanMutate(row, actorId, actorRoles);
      const duplicate = await this.store.findActive<ReportTemplate>(
        REPORT_TEMPLATES_SPEC,
        { where: { name: dto.name } as Partial<ReportTemplate>, limit: 2 },
      );
      if (duplicate.some((candidate) => candidate.id !== id)) {
        throw new BadRequestException(`같은 이름의 템플릿이 이미 있습니다: ${dto.name}`);
      }
      const before = { ...row };
      const after = await this.store.update<ReportTemplate>(REPORT_TEMPLATES_SPEC, id, { ...dto });
      if (!after) throw new NotFoundException(`ReportTemplate ${id} not found`);
      if (actorId != null) {
        await this.audit.log({
          entity: 'report_templates',
          entityId: id,
          action: 'update',
          actorId,
          changes: this.audit.maskContactPii(this.audit.diffOf(before, after)),
        });
      }
      return after;
    });
  }

  async remove(id: number, actorId?: number, actorRoles?: string[]): Promise<ReportTemplate> {
    return this.uow.run(async () => {
      await this.uow.lockTargets([{ kind: 'reportTemplate', id }]);
      const row = await this.findActiveById(id);
      this.assertCanMutate(row, actorId, actorRoles);
      const before = { ...row };
      await this.store.remove(REPORT_TEMPLATES_SPEC, id, actorId);
      // [감사 전수 2026-07-16] 전 테이블 CRUD 이력(대표 지시)
      // 스냅샷에 연락처 키 없음 — 방어적 마스킹(users.service maskTarget 규약과 동일 원칙).
      if (actorId != null) {
        await this.audit.log({
          entity: 'report_templates', entityId: id, action: 'delete', actorId,
          changes: this.audit.maskContactPii(this.audit.snapshotOf(before)),
        });
      }
      return before;
    });
  }
}
