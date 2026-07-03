import { BadRequestException, Injectable, NotFoundException, OnModuleInit } from '@nestjs/common';
import { InMemoryDatabase } from '../../database/in-memory.database';
import { ReportTemplate, REPORT_TEMPLATES } from './report-template.entity';
import { CreateReportTemplateDto } from './dto/create-report-template.dto';

@Injectable()
export class ReportTemplatesService implements OnModuleInit {
  constructor(private readonly db: InMemoryDatabase) {}

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

  create(dto: CreateReportTemplateDto): ReportTemplate {
    if (this.findAll().some((t) => t.name === dto.name))
      throw new BadRequestException(`같은 이름의 템플릿이 이미 있습니다: ${dto.name}`);
    return this.db.insert<ReportTemplate>(REPORT_TEMPLATES, { ...dto });
  }

  remove(id: number): ReportTemplate {
    const row = this.db.findById<ReportTemplate>(REPORT_TEMPLATES, id);
    if (!row) throw new NotFoundException(`ReportTemplate ${id} not found`);
    this.db.remove(REPORT_TEMPLATES, id);
    return row;
  }
}
