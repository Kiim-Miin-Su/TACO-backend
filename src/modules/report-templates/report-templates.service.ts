import { TimedModuleInit } from '../../common/performance-timing';
import { BadRequestException, ForbiddenException, Injectable, NotFoundException, OnModuleInit } from '@nestjs/common';
import { InMemoryDatabase } from '../../database/in-memory.database';
import { CalendarUnitOfWork } from '../../database/calendar-unit-of-work.service';
import { AuditService } from '../audit/audit.service';
import { ReportTemplate, REPORT_TEMPLATES } from './report-template.entity';
import { CreateReportTemplateDto } from './dto/create-report-template.dto';
import { UpdateReportTemplateDto } from './dto/update-report-template.dto';
import { PostgresCollectionStore } from '../../database/postgres-collection.store';
import { REPORT_TEMPLATES_SPEC } from '../../database/calendar-asset-specs';
import { hasAdminRole, isInstructorOnly } from '../auth/role-policy';
import { InstructorProfilesStore } from '../users/instructor-profiles.store';

@TimedModuleInit()
@Injectable()
export class ReportTemplatesService implements OnModuleInit {
  constructor(
    private readonly db: InMemoryDatabase,
    private readonly store: PostgresCollectionStore,
    private readonly uow: CalendarUnitOfWork,
    private readonly audit: AuditService,
    private readonly instructorProfiles: InstructorProfilesStore,
  ) {}

  // 시드 = 기존 zustand 기본 템플릿 2건 이관(자산화 — 프론트 하드코딩 제거)
  async onModuleInit(): Promise<void> {
    const templates = await this.store.hydrate<ReportTemplate>(REPORT_TEMPLATES_SPEC);
    if (templates.length) return;
    await this.store.seedReference<ReportTemplate>(REPORT_TEMPLATES_SPEC, [
      { id: 1, name: '정규 수업(기본)', content: '오늘 학습 내용: \n이해도: 상/중/하\n특이사항: ', homework: '교재 p.   ~   풀이', ownerUserId: null, isDefault: true, isEnforced: false },
      { id: 2, name: '시험 대비', content: '대비 범위: \n취약 단원: \n보강 권장: ', homework: '오답노트 정리', ownerUserId: null, isDefault: false, isEnforced: false },
    ]);
  }

  findAll(): ReportTemplate[] {
    return this.db.findAll<ReportTemplate>(REPORT_TEMPLATES);
  }

  private normalized(row: ReportTemplate): ReportTemplate {
    return {
      ...row,
      ownerUserId: row.ownerUserId ?? null,
      isDefault: row.isDefault ?? false,
      isEnforced: row.isEnforced ?? false,
    };
  }

  private async activeRows(): Promise<ReportTemplate[]> {
    return (await this.store.findActive<ReportTemplate>(
      REPORT_TEMPLATES_SPEC,
      { orderBy: { field: 'id' } },
    )).map((row) => this.normalized(row));
  }

  /** [TBO-86G3b] 목록 READ = DB 권위 + 역할별 scope. */
  async listDb(actorId?: number, actorRoles?: string[]): Promise<ReportTemplate[]> {
    const actor = this.requireActor(actorId);
    const rows = await this.activeRows();
    if (!isInstructorOnly(actorRoles)) return rows;
    return rows.filter((row) => row.ownerUserId == null || row.ownerUserId === actor);
  }

  async effective(instructorId?: number, actorId?: number, actorRoles?: string[]): Promise<ReportTemplate | null> {
    const actor = this.requireActor(actorId);
    const instructorOnly = isInstructorOnly(actorRoles);
    if (instructorOnly && instructorId != null && instructorId !== actor) {
      throw new ForbiddenException('다른 강사의 리포트 템플릿은 조회할 수 없습니다.');
    }
    const target = instructorOnly ? actor : (instructorId ?? null);
    if (target != null) await this.assertActiveInstructor(target);
    const rows = await this.activeRows();
    return rows.find((row) => row.ownerUserId == null && row.isEnforced)
      ?? (target == null ? undefined : rows.find((row) => row.ownerUserId === target && row.isDefault))
      ?? rows.find((row) => row.ownerUserId == null && row.isDefault)
      ?? null;
  }

  private assertCanMutate(row: ReportTemplate, actorId?: number, actorRoles?: string[]): void {
    if (hasAdminRole(actorRoles)) return;
    if (row.ownerUserId != null && actorId != null && row.ownerUserId === actorId) return;
    throw new ForbiddenException('본인 개인 템플릿만 수정/삭제할 수 있습니다(전역 템플릿은 매니저 이상).');
  }

  private requireActor(actorId?: number): number {
    if (actorId == null) throw new ForbiddenException('인증된 사용자 정보가 필요합니다.');
    return actorId;
  }

  private async assertActiveInstructor(ownerUserId: number): Promise<void> {
    await this.instructorProfiles.hydrate();
    if (!this.instructorProfiles.findActive(ownerUserId)) {
      throw new BadRequestException(`활성 강사만 템플릿 대상으로 지정할 수 있습니다: ${ownerUserId}`);
    }
  }

  private async resolveScope(
    dto: CreateReportTemplateDto,
    actorId: number,
    actorRoles?: string[],
    current?: ReportTemplate,
  ): Promise<Pick<ReportTemplate, 'ownerUserId' | 'isDefault' | 'isEnforced'>> {
    const admin = hasAdminRole(actorRoles);
    const requestedOwner = dto.ownerUserId === undefined ? current?.ownerUserId ?? null : dto.ownerUserId;
    if (!admin && requestedOwner != null && requestedOwner !== actorId) {
      throw new ForbiddenException('다른 강사의 개인 템플릿을 지정할 수 없습니다.');
    }
    if (!admin && dto.isEnforced === true) {
      throw new ForbiddenException('전역 강제 템플릿은 매니저 이상만 지정할 수 있습니다.');
    }
    const ownerUserId = admin ? requestedOwner : actorId;
    if (ownerUserId != null) await this.assertActiveInstructor(ownerUserId);
    const isDefault = dto.isDefault ?? current?.isDefault ?? false;
    const isEnforced = dto.isEnforced ?? current?.isEnforced ?? false;
    if (isEnforced && ownerUserId != null) {
      throw new BadRequestException('강제 템플릿은 전역 scope에서만 지정할 수 있습니다.');
    }
    return { ownerUserId, isDefault, isEnforced };
  }

  private sameScope(left: number | null | undefined, right: number | null | undefined): boolean {
    return (left ?? null) === (right ?? null);
  }

  private assertUniqueName(rows: ReportTemplate[], name: string, ownerUserId: number | null, exceptId?: number): void {
    if (rows.some((row) => row.id !== exceptId && row.name === name && this.sameScope(row.ownerUserId, ownerUserId))) {
      throw new BadRequestException(`같은 scope에 같은 이름의 템플릿이 이미 있습니다: ${name}`);
    }
  }

  private async updateWithAudit(
    row: ReportTemplate,
    patch: Partial<ReportTemplate>,
    actorId: number,
  ): Promise<ReportTemplate> {
    const after = await this.store.update<ReportTemplate>(REPORT_TEMPLATES_SPEC, row.id, patch);
    if (!after) throw new NotFoundException(`ReportTemplate ${row.id} not found`);
    await this.audit.log({
      entity: 'report_templates',
      entityId: row.id,
      action: 'update',
      actorId,
      changes: this.audit.maskContactPii(this.audit.diffOf(row, after)),
    });
    return this.normalized(after);
  }

  private async clearCompetingSelections(
    rows: ReportTemplate[],
    targetId: number | undefined,
    scope: Pick<ReportTemplate, 'ownerUserId' | 'isDefault' | 'isEnforced'>,
    actorId: number,
  ): Promise<void> {
    for (const row of rows) {
      if (row.id === targetId) continue;
      if (scope.isDefault && row.isDefault && this.sameScope(row.ownerUserId, scope.ownerUserId)) {
        await this.updateWithAudit(row, { isDefault: false }, actorId);
      }
      if (scope.isEnforced && row.isEnforced && row.ownerUserId == null) {
        await this.updateWithAudit(row, { isEnforced: false }, actorId);
      }
    }
  }

  private async findActiveById(id: number): Promise<ReportTemplate> {
    const [row] = await this.store.findActive<ReportTemplate>(
      REPORT_TEMPLATES_SPEC,
      { where: { id } as Partial<ReportTemplate>, limit: 1 },
    );
    if (!row) throw new NotFoundException(`ReportTemplate ${id} not found`);
    return this.normalized(row);
  }

  // actorId 없으면(시드·내부 경로) audit 생략. 쓰기+audit 한 tx(uow).
  async create(dto: CreateReportTemplateDto, actorId?: number, actorRoles?: string[]): Promise<ReportTemplate> {
    return this.uow.run(async () => {
      const actor = this.requireActor(actorId);
      const scope = await this.resolveScope(dto, actor, actorRoles);
      await this.uow.lockTargets([{ kind: 'reportTemplateScope', id: scope.ownerUserId ?? 0 }]);
      const rows = await this.activeRows();
      this.assertUniqueName(rows, dto.name, scope.ownerUserId ?? null);
      await this.clearCompetingSelections(rows, undefined, scope, actor);
      const row = await this.store.insert<ReportTemplate>(
        REPORT_TEMPLATES_SPEC,
        {
          name: dto.name,
          content: dto.content,
          progressPage: dto.progressPage,
          homework: dto.homework,
          ...scope,
          createdBy: actor,
        },
      );
      // [감사 전수 2026-07-16] 전 테이블 CRUD 이력(대표 지시)
      await this.audit.log({ entity: 'report_templates', entityId: row.id, action: 'create', actorId: actor });
      return this.normalized(row);
    });
  }

  async update(
    id: number,
    dto: UpdateReportTemplateDto,
    actorId?: number,
    actorRoles?: string[],
  ): Promise<ReportTemplate> {
    return this.uow.run(async () => {
      const actor = this.requireActor(actorId);
      await this.uow.lockTargets([{ kind: 'reportTemplate', id }]);
      const row = await this.findActiveById(id);
      this.assertCanMutate(row, actor, actorRoles);
      const scope = await this.resolveScope(dto, actor, actorRoles, row);
      await this.uow.lockTargets([
        { kind: 'reportTemplateScope', id: row.ownerUserId ?? 0 },
        { kind: 'reportTemplateScope', id: scope.ownerUserId ?? 0 },
      ]);
      const rows = await this.activeRows();
      this.assertUniqueName(rows, dto.name, scope.ownerUserId ?? null, id);
      await this.clearCompetingSelections(rows, id, scope, actor);
      return this.updateWithAudit(row, {
        name: dto.name,
        content: dto.content,
        progressPage: dto.progressPage ?? '',
        homework: dto.homework ?? '',
        ...scope,
      }, actor);
    });
  }

  async remove(id: number, actorId?: number, actorRoles?: string[]): Promise<ReportTemplate> {
    return this.uow.run(async () => {
      const actor = this.requireActor(actorId);
      await this.uow.lockTargets([{ kind: 'reportTemplate', id }]);
      const row = await this.findActiveById(id);
      this.assertCanMutate(row, actor, actorRoles);
      await this.uow.lockTargets([{ kind: 'reportTemplateScope', id: row.ownerUserId ?? 0 }]);
      const before = { ...row };
      await this.store.remove(REPORT_TEMPLATES_SPEC, id, actor);
      // [감사 전수 2026-07-16] 전 테이블 CRUD 이력(대표 지시)
      // 스냅샷에 연락처 키 없음 — 방어적 마스킹(users.service maskTarget 규약과 동일 원칙).
      await this.audit.log({
        entity: 'report_templates', entityId: id, action: 'delete', actorId: actor,
        changes: this.audit.maskContactPii(this.audit.snapshotOf(before)),
      });
      return before;
    });
  }
}
