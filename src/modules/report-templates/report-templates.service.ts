import { BadRequestException, Injectable, NotFoundException, OnModuleInit } from '@nestjs/common';
import { InMemoryDatabase } from '../../database/in-memory.database';
import { CalendarUnitOfWork } from '../../database/calendar-unit-of-work.service';
import { AuditService } from '../audit/audit.service';
import { ReportTemplate, REPORT_TEMPLATES } from './report-template.entity';
import { CreateReportTemplateDto } from './dto/create-report-template.dto';

@Injectable()
export class ReportTemplatesService implements OnModuleInit {
  constructor(
    private readonly db: InMemoryDatabase,
    private readonly uow: CalendarUnitOfWork,
    private readonly audit: AuditService,
  ) {}

  // 시드 = 기존 zustand 기본 템플릿 2건 이관(자산화 — 프론트 하드코딩 제거)
  onModuleInit(): void {
    if (this.db.findAll<ReportTemplate>(REPORT_TEMPLATES).length) return;
    this.db.seed<ReportTemplate>(REPORT_TEMPLATES, [
      { id: 1, name: '정규 수업(기본)', content: '오늘 학습 내용: \n이해도: 상/중/하\n특이사항: ', homework: '교재 p.   ~   풀이' },
      { id: 2, name: '시험 대비', content: '대비 범위: \n취약 단원: \n보강 권장: ', homework: '오답노트 정리' },
    ]);
  }

  findAll(): ReportTemplate[] {
    return this.db.findAll<ReportTemplate>(REPORT_TEMPLATES);
  }

  // actorId 없으면(시드·내부 경로) audit 생략. 쓰기+audit 한 tx(uow).
  async create(dto: CreateReportTemplateDto, actorId?: number): Promise<ReportTemplate> {
    if (this.findAll().some((t) => t.name === dto.name))
      throw new BadRequestException(`같은 이름의 템플릿이 이미 있습니다: ${dto.name}`);
    return this.uow.run(async () => {
      const row = this.db.insert<ReportTemplate>(REPORT_TEMPLATES, { ...dto });
      // [감사 전수 2026-07-16] 전 테이블 CRUD 이력(대표 지시)
      if (actorId != null) await this.audit.log({ entity: 'report_templates', entityId: row.id, action: 'create', actorId });
      return row;
    });
  }

  async remove(id: number, actorId?: number): Promise<ReportTemplate> {
    const row = this.db.findById<ReportTemplate>(REPORT_TEMPLATES, id);
    if (!row) throw new NotFoundException(`ReportTemplate ${id} not found`);
    const before = { ...row };
    return this.uow.run(async () => {
      this.db.remove(REPORT_TEMPLATES, id);
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
