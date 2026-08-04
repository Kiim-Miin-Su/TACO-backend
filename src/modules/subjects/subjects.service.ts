import { TimedModuleInit } from '../../common/performance-timing';
import { ConflictException, Injectable, NotFoundException, OnModuleInit } from '@nestjs/common';
import type { BaseRow } from '../../common/types/base';
import { InMemoryDatabase } from '../../database/in-memory.database';
import { COURSES_SPEC, SESSION_REPORTS_SPEC, SUBJECTS_SPEC } from '../../database/calendar-asset-specs';
import { PostgresCollectionStore } from '../../database/postgres-collection.store';
import { CalendarUnitOfWork } from '../../database/calendar-unit-of-work.service';
import { AuditService } from '../audit/audit.service';
import { Subject, SUBJECTS } from './subject.entity';
import { CreateSubjectDto } from './dto/create-subject.dto';
import { UpdateSubjectDto } from './dto/update-subject.dto';
import { Course } from '../courses/course.entity';

type SubjectReportRef = BaseRow & { subjectId: number };

@TimedModuleInit()
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
    await this.store.hydrate<Subject>(SUBJECTS_SPEC);
  }

  findAll(): Subject[] {
    return this.db.findAll<Subject>(SUBJECTS);
  }

  /** 서버리스 교차 인스턴스의 과목 변경을 PostgreSQL에서 다시 읽어 HTTP 캐시 투영을 갱신한다. */
  async findAllFresh(): Promise<Subject[]> {
    await this.store.hydrate<Subject>(SUBJECTS_SPEC);
    return this.findAll();
  }

  findOne(id: number): Subject {
    const row = this.db.findById<Subject>(SUBJECTS, id);
    if (!row) throw new NotFoundException(`Subject ${id} not found`);
    return row;
  }

  async findOneFresh(id: number): Promise<Subject> {
    await this.store.hydrate<Subject>(SUBJECTS_SPEC);
    return this.findOne(id);
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

  async update(id: number, dto: UpdateSubjectDto, actorId?: number): Promise<Subject> {
    const before = { ...this.findOne(id) };
    if (dto.code != null) {
      const duplicate = (await this.store.findActive<Subject>(SUBJECTS_SPEC, { where: { code: dto.code }, limit: 1 }))[0];
      if (duplicate && duplicate.id !== id) throw new ConflictException('이미 사용 중인 과목 코드입니다.');
    }
    return this.uow.run(async () => {
      await this.uow.lockTargets([{ kind: 'subject', id }]);
      const after = await this.store.update<Subject>(SUBJECTS_SPEC, id, dto) as Subject;
      if (actorId != null) {
        await this.audit.log({ entity: 'subjects', entityId: id, action: 'update', actorId, changes: this.audit.diffOf(before, after) });
      }
      return after;
    });
  }

  async remove(id: number, actorId?: number): Promise<Subject> {
    return this.uow.run(async () => {
      await this.uow.lockTargets([{ kind: 'subject', id }]);
      const before = { ...this.findOne(id) };
      const [course, report] = await Promise.all([
        this.store.findActive<Course>(COURSES_SPEC, { where: { subjectId: id }, limit: 1 }),
        this.store.findActive<SubjectReportRef>(SESSION_REPORTS_SPEC, { where: { subjectId: id }, limit: 1 }),
      ]);
      const blockers = [course.length && '코스', report.length && '보고서'].filter(Boolean);
      if (blockers.length) throw new ConflictException(`참조 중인 과목은 삭제할 수 없습니다: ${blockers.join('·')}`);
      await this.store.remove(SUBJECTS_SPEC, id, actorId);
      if (actorId != null) {
        await this.audit.log({ entity: 'subjects', entityId: id, action: 'delete', actorId, changes: this.audit.snapshotOf(before) });
      }
      return before;
    });
  }
}
