import { BadRequestException, ConflictException, Injectable, NotFoundException, OnModuleInit } from '@nestjs/common';
import { InMemoryDatabase } from '../../database/in-memory.database';
import { PostgresCollectionStore } from '../../database/postgres-collection.store';
import { CalendarUnitOfWork } from '../../database/calendar-unit-of-work.service';
import { PARENTS_SPEC, PARENT_STUDENT_RELATIONS_SPEC } from '../../database/calendar-asset-specs';
import { StudentsService } from '../students/students.service';
import { AuditService } from '../audit/audit.service';
import { Student, STUDENTS } from '../students/student.entity';
import { Parent, ParentStudent, PARENTS, PARENT_STUDENTS } from './parent.entity';
import { CreateParentDto } from './dto/create-parent.dto';
import { LinkParentDto, UpdateRelationDto } from './dto/link-parent.dto';

/**
 * [참조/처리] 보호자 + 학생↔보호자 M:N. 프론트 목데이터 이관 + 참조 무결성 게이트.
 *  - 시드: 보호자 3(김미경/이상철/최영희) + 관계 3(학생 1·2·4 각 대표 1명) — students 시드와 정합.
 *  무결성 3종:
 *   1) FK: parentId→parents, studentId→students 존재 검증(없으면 400) + DB FK(20260715_04).
 *   2) (parentId, studentId) 유니크: 같은 보호자-학생 중복 연결 금지(409) + 활성 partial unique.
 *   3) 대표(primary)는 학생당 최대 1명: 새 대표 지정 시 기존 대표 자동 강등 + partial unique 강제.
 *
 *  [TBO-29D D1 2026-07-15] 메모리 전용 → Postgres write-through 이관. 쓰기는 uow.run(메모리 tx ⊃ PG tx)
 *  + lockTargets(student)로 직렬화 — 대표 불변·중복 연결 경합이 재기동 후에도 결정적으로 유지된다.
 *  StudentsService 주입은 FK 검증 외에 **init 순서 보장**(students 테이블 선생성 → FK DO 블록 적용) 목적.
 */
@Injectable()
export class ParentsService implements OnModuleInit {
  constructor(
    private readonly db: InMemoryDatabase,
    private readonly store: PostgresCollectionStore,
    private readonly uow: CalendarUnitOfWork,
    private readonly students: StudentsService,
    private readonly audit: AuditService,
  ) {}

  async onModuleInit(): Promise<void> {
    const parents = await this.store.hydrate<Parent>(PARENTS_SPEC);
    const relations = await this.store.hydrate<ParentStudent>(PARENT_STUDENT_RELATIONS_SPEC);
    if (parents.length || relations.length || this.db.findAll<Parent>(PARENTS).length) return;
    await this.store.seed<Parent>(PARENTS_SPEC, [
      { id: 1, name: '김미경', phone: '010-1111-2222', kakaoAvailable: true },
      { id: 2, name: '이상철', phone: '010-3333-4444', kakaoAvailable: true },
      { id: 3, name: '최영희', phone: '010-5555-6666', kakaoAvailable: false },
    ]);
    await this.store.seed<ParentStudent>(PARENT_STUDENT_RELATIONS_SPEC, [
      { id: 1, parentId: 1, studentId: 1, relation: '모', isPayer: true, isPrimary: true },
      { id: 2, parentId: 2, studentId: 2, relation: '부', isPayer: true, isPrimary: true },
      { id: 3, parentId: 3, studentId: 4, relation: '모', isPayer: true, isPrimary: true },
    ]);
  }

  findAll(): Parent[] {
    return this.db.findAll<Parent>(PARENTS);
  }

  findAllRelations(): ParentStudent[] {
    return this.db.findAll<ParentStudent>(PARENT_STUDENTS);
  }

  // 신규 보호자 + 학생 연결(intake). [원자성] 생성+연결(+기존 대표 강등)이 한 PG tx — 고아 보호자/이중 대표 방지.
  // actorId 없으면(시드·내부 경로) audit 생략.
  async create(dto: CreateParentDto, actorId?: number): Promise<{ parent: Parent; relation: ParentStudent }> {
    return this.uow.run(async () => {
      await this.uow.lockTargets([{ kind: 'student', id: dto.studentId }]);
      if (!this.db.findById<Student>(STUDENTS, dto.studentId))
        throw new BadRequestException(`studentId ${dto.studentId} 없음(존재하지 않는 학생)`);
      const parent = await this.store.insert<Parent>(PARENTS_SPEC, {
        name: dto.name,
        phone: dto.phone ?? '',
        kakaoAvailable: false,
        webId: dto.webId,
      });
      // [감사 전수 2026-07-16] 전 테이블 CRUD 이력(대표 지시) — changes 없음(phone 등 PII는 이력에 남기지 않음).
      if (actorId != null) await this.audit.log({ entity: 'parents', entityId: parent.id, action: 'create', actorId });
      const relation = await this.linkInTx({
        parentId: parent.id,
        studentId: dto.studentId,
        relation: dto.relation,
        isPayer: dto.isPayer,
        isPrimary: dto.isPrimary,
      }, actorId);
      return { parent, relation };
    });
  }

  // 기존 보호자를 학생에 연결(형제 등 M:N). FK·유니크·대표 불변 강제.
  async link(dto: LinkParentDto, actorId?: number): Promise<ParentStudent> {
    return this.uow.run(async () => {
      await this.uow.lockTargets([{ kind: 'student', id: dto.studentId }]);
      return this.linkInTx(dto, actorId);
    });
  }

  /** [TBO-29D D2] 등록 aggregate 전용(tx 내부에서만 호출) — 보호자 전화 일치 시 기존 행에 연결(upsert-or-link).
   *  정책: 같은 전화번호 = 같은 보호자(학원 실무 규약). 이름은 덮어쓰지 않고 기존 행을 반환 —
   *  응답의 linkedExisting으로 FE가 "기존 보호자와 연결됨"을 안내한다. 경합은 호출자의
   *  parentIntake advisory lock이 직렬화(같은 번호 동시 등록 → 보호자 1행). */
  async attachGuardianInTx(
    studentId: number,
    guardian: { name: string; phone?: string; relation?: string; isPayer?: boolean; isPrimary?: boolean },
    actorId?: number,
  ): Promise<{ parent: Parent; relation: ParentStudent; linkedExisting: boolean }> {
    const digits = (v?: string) => (v ?? '').replace(/\D/g, '');
    const normalized = digits(guardian.phone);
    const existing = normalized
      ? this.db.findBy<Parent>(PARENTS, (parent) => digits(parent.phone) === normalized)[0]
      : undefined;
    const parent = existing
      ?? (await this.store.insert<Parent>(PARENTS_SPEC, {
        name: guardian.name,
        phone: guardian.phone ?? '',
        kakaoAvailable: false,
      }));
    // [감사 전수 2026-07-16] 전 테이블 CRUD 이력(대표 지시) — 신규 보호자 행이 실제 생성된 경우에만
    //  (기존 행 재연결 시 create 아님). changes 없음(phone 등 PII는 이력에 남기지 않음 — registrations 규약).
    if (!existing && actorId != null) await this.audit.log({ entity: 'parents', entityId: parent.id, action: 'create', actorId });
    const relation = await this.linkInTx({
      parentId: parent.id,
      studentId,
      relation: guardian.relation,
      isPayer: guardian.isPayer ?? true,
      isPrimary: guardian.isPrimary ?? true,
    }, actorId);
    return { parent, relation, linkedExisting: !!existing };
  }

  // tx 내부 전용 — create()/link()/attachGuardianInTx가 같은 uow tx에서 호출(중첩 uow.run 금지).
  private async linkInTx(dto: LinkParentDto, actorId?: number): Promise<ParentStudent> {
    if (!this.db.findById<Parent>(PARENTS, dto.parentId))
      throw new BadRequestException(`parentId ${dto.parentId} 없음(존재하지 않는 보호자)`);
    if (!this.db.findById<Student>(STUDENTS, dto.studentId))
      throw new BadRequestException(`studentId ${dto.studentId} 없음(존재하지 않는 학생)`);

    const dup = this.db.findBy<ParentStudent>(
      PARENT_STUDENTS,
      (r) => r.parentId === dto.parentId && r.studentId === dto.studentId,
    );
    if (dup.length) throw new ConflictException(`보호자 ${dto.parentId}·학생 ${dto.studentId} 연결이 이미 존재`);

    if (dto.isPrimary) await this.demotePrimary(dto.studentId, undefined, actorId);
    const relation = await this.store.insert<ParentStudent>(PARENT_STUDENT_RELATIONS_SPEC, {
      parentId: dto.parentId,
      studentId: dto.studentId,
      relation: dto.relation,
      isPayer: dto.isPayer ?? false,
      isPrimary: dto.isPrimary ?? false,
    });
    // [감사 전수 2026-07-16] 전 테이블 CRUD 이력(대표 지시)
    if (actorId != null) await this.audit.log({ entity: 'parent_student_relations', entityId: relation.id, action: 'create', actorId });
    return relation;
  }

  // 관계 수정(대표 이전·납부자). 대표 지정 시 기존 대표 강등 → 학생당 대표 ≤1 유지(한 tx).
  async updateRelation(id: number, dto: UpdateRelationDto, actorId?: number): Promise<ParentStudent> {
    return this.uow.run(async () => {
      const rel = this.db.findById<ParentStudent>(PARENT_STUDENTS, id);
      if (!rel) throw new NotFoundException(`관계 ${id} 없음`);
      await this.uow.lockTargets([{ kind: 'student', id: rel.studentId }]);
      const before = { ...rel };
      if (dto.isPrimary === true) await this.demotePrimary(rel.studentId, id, actorId);
      const after = (await this.store.update<ParentStudent>(PARENT_STUDENT_RELATIONS_SPEC, id, {
        ...(dto.relation !== undefined ? { relation: dto.relation } : {}),
        ...(dto.isPayer !== undefined ? { isPayer: dto.isPayer } : {}),
        ...(dto.isPrimary !== undefined ? { isPrimary: dto.isPrimary } : {}),
      })) as ParentStudent;
      // [감사 전수 2026-07-16] 전 테이블 CRUD 이력(대표 지시) — 관계 필드 diff에는 연락처 PII 없음(방어적 마스킹 적용).
      if (actorId != null) {
        await this.audit.log({
          entity: 'parent_student_relations', entityId: id, action: 'update', actorId,
          changes: this.audit.maskContactPii(this.audit.diffOf(before, after)),
        });
      }
      return after;
    });
  }

  // 학생의 기존 대표(primary)를 모두 강등(exceptId는 유지). 같은 tx에서 선행 실행 —
  // partial unique(uq_parent_student_primary)가 non-deferred여도 위반 없이 통과한다.
  private async demotePrimary(studentId: number, exceptId?: number, actorId?: number): Promise<void> {
    const rows = this.db.findBy<ParentStudent>(
      PARENT_STUDENTS,
      (r) => r.studentId === studentId && r.isPrimary && r.id !== exceptId,
    );
    for (const r of rows) {
      const before = { ...r };
      const after = (await this.store.update<ParentStudent>(PARENT_STUDENT_RELATIONS_SPEC, r.id, { isPrimary: false })) as ParentStudent;
      // [감사 전수 2026-07-16] 전 테이블 CRUD 이력(대표 지시) — 대표 자동 강등도 diff로 남긴다.
      if (actorId != null) {
        await this.audit.log({
          entity: 'parent_student_relations', entityId: r.id, action: 'update', actorId,
          changes: this.audit.diffOf(before, after),
        });
      }
    }
  }
}
