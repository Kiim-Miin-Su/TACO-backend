import { Injectable, NotFoundException, OnModuleInit } from '@nestjs/common';
import { InMemoryDatabase } from '../../database/in-memory.database';
import { SUBJECTS_SPEC } from '../../database/calendar-asset-specs';
import { PostgresCollectionStore } from '../../database/postgres-collection.store';
import { CalendarUnitOfWork } from '../../database/calendar-unit-of-work.service';
import { AuditService } from '../audit/audit.service';
import { Subject, SUBJECTS } from './subject.entity';
import { CreateSubjectDto } from './dto/create-subject.dto';

@Injectable()
export class SubjectsService implements OnModuleInit {
  constructor(
    private readonly db: InMemoryDatabase,
    private readonly store: PostgresCollectionStore,
    private readonly uow: CalendarUnitOfWork,
    private readonly audit: AuditService,
  ) {}

  // 데모 과목 시드 — 스케줄 모듈 SUBJECTS 라벨(1:영어, 2:수학)과 id 정렬.
  // courses.subjectId → subjects.id 조인 무결성의 단일 소스.
  async onModuleInit(): Promise<void> {
    const hydrated = await this.store.hydrate<Subject>(SUBJECTS_SPEC);
    if (hydrated.length) return;
    await this.store.seed<Subject>(SUBJECTS_SPEC, [
      { id: 1, code: 'english', name: '영어' },
      { id: 2, code: 'math', name: '수학' },
    ]);
  }

  findAll(): Subject[] {
    return this.db.findAll<Subject>(SUBJECTS);
  }

  findOne(id: number): Subject {
    const row = this.db.findById<Subject>(SUBJECTS, id);
    if (!row) throw new NotFoundException(`Subject ${id} not found`);
    return row;
  }

  // actorId 없으면(시드·내부 경로) audit 생략. 쓰기+audit 한 tx(uow).
  async create(dto: CreateSubjectDto, actorId?: number): Promise<Subject> {
    return this.uow.run(async () => {
      const row = await this.store.insert<Subject>(SUBJECTS_SPEC, { code: dto.code, name: dto.name });
      // [감사 전수 2026-07-16] 전 테이블 CRUD 이력(대표 지시)
      if (actorId != null) await this.audit.log({ entity: 'subjects', entityId: row.id, action: 'create', actorId });
      return row;
    });
  }
}
