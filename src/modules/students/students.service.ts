import { BadRequestException, ConflictException, Injectable, NotFoundException, OnModuleInit } from '@nestjs/common';
import type { StudentAggregate } from '@kms545487/contracts';
import { InMemoryDatabase } from '../../database/in-memory.database';
import {
  ENROLLMENTS_SPEC,
  PARENT_STUDENT_RELATIONS_SPEC,
  STUDENT_ACADEMIC_HISTORIES_SPEC,
  STUDENT_FAMILY_RELATIONS_SPEC,
  STUDENT_INTERESTS_SPEC,
  STUDENTS_SPEC,
} from '../../database/calendar-asset-specs';
import { PostgresCollectionStore } from '../../database/postgres-collection.store';
import { CalendarUnitOfWork } from '../../database/calendar-unit-of-work.service';
import { AuditService } from '../audit/audit.service';
import { Student, STUDENTS } from './student.entity';
import { Enrollment, ENROLLMENTS } from '../enrollments/enrollment.entity';
import { CreateStudentDto } from './dto/create-student.dto';
import { UpdateStudentDto } from './dto/update-student.dto';
import { Parent, ParentStudent, PARENTS, PARENT_STUDENTS } from '../parents/parent.entity';
import { StudentInterest, STUDENT_INTERESTS } from './student-interest.entity';
import { studentGradeBirthDateError } from './student-grade.policy';
import { StudentFamilyRelation, STUDENT_FAMILY_RELATIONS } from './student-family-relation.entity';
import { StudentAcademicHistory, STUDENT_ACADEMIC_HISTORIES } from './student-academic-history.entity';
import { CreateStudentFamilyRelationDto, UpdateStudentFamilyRelationDto } from './dto/student-family-relation.dto';
import { CreateStudentAcademicHistoryDto, UpdateStudentAcademicHistoryDto } from './dto/student-academic-history.dto';

@Injectable()
export class StudentsService implements OnModuleInit {
  constructor(
    private readonly db: InMemoryDatabase,
    private readonly store: PostgresCollectionStore,
    private readonly uow: CalendarUnitOfWork,
    private readonly audit: AuditService, // [감사 전수 2026-07-16] 직접 CRUD 이력(집계 경로는 registrations가 기록)
  ) {}

  // 데모 학생 시드 — 프론트 목데이터를 백엔드로 이관(고정 id로 관계 정합 유지).
  // 프론트는 이제 이 데이터를 GET /students로 가져와 store에 적재(단일 소스: 백엔드).
  async onModuleInit(): Promise<void> {
    const hydrated = await this.store.hydrate<Student>(STUDENTS_SPEC);
    await this.store.hydrate<StudentFamilyRelation>(STUDENT_FAMILY_RELATIONS_SPEC);
    await this.store.hydrate<StudentAcademicHistory>(STUDENT_ACADEMIC_HISTORIES_SPEC);
    if (hydrated.length || this.db.findAll<Student>(STUDENTS).length) return;
    await this.store.seed<Student>(STUDENTS_SPEC, [
      { id: 1, name: '김서연', englishName: 'Sophia', birthDate: '2009-03-14', grade: 11, residenceType: 'overseas', country: 'US', status: 'enrolled' },
      { id: 2, name: '이준호', englishName: 'Daniel', birthDate: '2008-08-21', grade: 12, residenceType: 'domestic', country: 'KR', status: 'enrolled' },
      { id: 3, name: '박지민', englishName: 'Emma', birthDate: '2010-11-02', grade: 10, residenceType: 'overseas', country: 'VN', status: 'on_leave' },
      { id: 4, name: '최민준', englishName: 'Lucas', birthDate: '2009-06-09', grade: 11, residenceType: 'domestic', status: 'enrolled' },
    ]);
  }

  findAll(): Student[] {
    return this.db.findAll<Student>(STUDENTS);
  }

  findOne(id: number): Student {
    const student = this.db.findById<Student>(STUDENTS, id);
    if (!student) throw new NotFoundException(`Student ${id} not found`);
    return student;
  }

  findAggregate(id: number): StudentAggregate {
    const student = this.findOne(id);
    const guardians = this.db.findByField<ParentStudent>(PARENT_STUDENTS, 'studentId', id)
      .map((relation) => ({ parent: this.db.findById<Parent>(PARENTS, relation.parentId), relation }))
      .filter((entry): entry is { parent: Parent; relation: ParentStudent } => entry.parent != null)
      .sort((a, b) => Number(b.relation.isPrimary) - Number(a.relation.isPrimary) || a.relation.id - b.relation.id);
    return {
      student,
      interests: this.db.findByField<StudentInterest>(STUDENT_INTERESTS, 'studentId', id)
        .sort((a, b) => a.priority - b.priority || a.id - b.id),
      guardians,
      familyRelations: this.findFamilyRelations(id),
      academicHistories: this.findAcademicHistories(id),
    };
  }

  findFamilyRelations(studentId: number): StudentFamilyRelation[] {
    this.findOne(studentId);
    return this.db.findBy<StudentFamilyRelation>(STUDENT_FAMILY_RELATIONS, (row) =>
      row.studentIdA === studentId || row.studentIdB === studentId)
      .sort((a, b) => a.id - b.id);
  }

  async createFamilyRelation(studentId: number, dto: CreateStudentFamilyRelationDto, actorId: number): Promise<StudentFamilyRelation> {
    if (studentId === dto.relatedStudentId) throw new BadRequestException('학생은 자기 자신과 가족 관계를 맺을 수 없습니다.');
    this.findOne(studentId);
    this.findOne(dto.relatedStudentId);
    const [studentIdA, studentIdB] = [studentId, dto.relatedStudentId].sort((a, b) => a - b);
    const normalized = this.normalizeFamilyRelation(dto.relationType, dto.relationLabel);
    return this.uow.run(async () => {
      await this.uow.lockTargets([{ kind: 'student', id: studentIdA }, { kind: 'student', id: studentIdB }]);
      const duplicate = this.db.findBy<StudentFamilyRelation>(STUDENT_FAMILY_RELATIONS, (row) =>
        row.studentIdA === studentIdA && row.studentIdB === studentIdB)[0];
      if (duplicate) throw new ConflictException('두 학생의 활성 가족 관계가 이미 존재합니다.');
      const row = await this.store.insert<StudentFamilyRelation>(STUDENT_FAMILY_RELATIONS_SPEC, {
        studentIdA, studentIdB, ...normalized,
      });
      await this.audit.log({
        entity: STUDENT_FAMILY_RELATIONS, entityId: row.id, action: 'create', actorId,
        changes: this.audit.diffOf({}, row),
      });
      return row;
    });
  }

  async updateFamilyRelation(
    studentId: number,
    relationId: number,
    dto: UpdateStudentFamilyRelationDto,
    actorId: number,
  ): Promise<StudentFamilyRelation> {
    return this.uow.run(async () => {
      const before = { ...this.familyRelationForStudent(studentId, relationId) };
      await this.uow.lockTargets([{ kind: 'student', id: before.studentIdA }, { kind: 'student', id: before.studentIdB }]);
      const normalized = this.normalizeFamilyRelation(
        dto.relationType ?? before.relationType,
        dto.relationLabel !== undefined
          ? dto.relationLabel
          : dto.relationType === 'sibling' ? null : before.relationLabel,
      );
      const after = await this.store.update<StudentFamilyRelation>(STUDENT_FAMILY_RELATIONS_SPEC, relationId, normalized);
      if (!after) throw new NotFoundException(`가족 관계 ${relationId} 없음`);
      await this.audit.log({
        entity: STUDENT_FAMILY_RELATIONS, entityId: relationId, action: 'update', actorId,
        changes: this.audit.diffOf(before, after),
      });
      return after;
    });
  }

  async removeFamilyRelation(studentId: number, relationId: number, actorId: number): Promise<{ id: number; deleted: true }> {
    return this.uow.run(async () => {
      const before = { ...this.familyRelationForStudent(studentId, relationId) };
      await this.uow.lockTargets([{ kind: 'student', id: before.studentIdA }, { kind: 'student', id: before.studentIdB }]);
      await this.store.remove(STUDENT_FAMILY_RELATIONS_SPEC, relationId, actorId);
      await this.audit.log({
        entity: STUDENT_FAMILY_RELATIONS, entityId: relationId, action: 'delete', actorId,
        changes: this.audit.snapshotOf(before),
      });
      return { id: relationId, deleted: true };
    });
  }

  findAcademicHistories(studentId: number): StudentAcademicHistory[] {
    this.findOne(studentId);
    return this.db.findByField<StudentAcademicHistory>(STUDENT_ACADEMIC_HISTORIES, 'studentId', studentId)
      .sort((a, b) => a.startedOn.localeCompare(b.startedOn) || a.id - b.id);
  }

  async createAcademicHistory(
    studentId: number,
    dto: CreateStudentAcademicHistoryDto,
    actorId: number,
  ): Promise<StudentAcademicHistory> {
    this.findOne(studentId);
    const normalized = this.normalizeAcademicHistory(dto);
    return this.uow.run(async () => {
      await this.uow.lockTargets([{ kind: 'student', id: studentId }]);
      this.assertNoAcademicOverlap(studentId, normalized);
      const row = await this.store.insert<StudentAcademicHistory>(STUDENT_ACADEMIC_HISTORIES_SPEC, {
        studentId, ...normalized, changedBy: actorId, changedAt: new Date().toISOString(),
      });
      await this.audit.log({
        entity: STUDENT_ACADEMIC_HISTORIES, entityId: row.id, action: 'create', actorId,
        changes: this.audit.diffOf({}, row),
      });
      await this.syncCurrentAcademicProjection(studentId, actorId, `academic-history-create:${row.id}`);
      return row;
    });
  }

  async updateAcademicHistory(
    studentId: number,
    historyId: number,
    dto: UpdateStudentAcademicHistoryDto,
    actorId: number,
  ): Promise<StudentAcademicHistory> {
    return this.uow.run(async () => {
      await this.uow.lockTargets([{ kind: 'student', id: studentId }]);
      const before = { ...this.academicHistoryForStudent(studentId, historyId) };
      const normalized = this.normalizeAcademicHistory({ ...before, ...dto });
      this.assertNoAcademicOverlap(studentId, normalized, historyId);
      const after = await this.store.update<StudentAcademicHistory>(STUDENT_ACADEMIC_HISTORIES_SPEC, historyId, {
        ...normalized, changedBy: actorId, changedAt: new Date().toISOString(),
      });
      if (!after) throw new NotFoundException(`학교/학년 이력 ${historyId} 없음`);
      await this.audit.log({
        entity: STUDENT_ACADEMIC_HISTORIES, entityId: historyId, action: 'update', actorId,
        changes: this.audit.diffOf(before, after),
      });
      await this.syncCurrentAcademicProjection(studentId, actorId, `academic-history-update:${historyId}`);
      return after;
    });
  }

  async removeAcademicHistory(studentId: number, historyId: number, actorId: number): Promise<{ id: number; deleted: true }> {
    return this.uow.run(async () => {
      await this.uow.lockTargets([{ kind: 'student', id: studentId }]);
      const before = { ...this.academicHistoryForStudent(studentId, historyId) };
      await this.store.remove(STUDENT_ACADEMIC_HISTORIES_SPEC, historyId, actorId);
      await this.audit.log({
        entity: STUDENT_ACADEMIC_HISTORIES, entityId: historyId, action: 'delete', actorId,
        changes: this.audit.snapshotOf(before),
      });
      await this.syncCurrentAcademicProjection(studentId, actorId, `academic-history-delete:${historyId}`);
      return { id: historyId, deleted: true };
    });
  }

  private familyRelationForStudent(studentId: number, relationId: number): StudentFamilyRelation {
    this.findOne(studentId);
    const row = this.db.findById<StudentFamilyRelation>(STUDENT_FAMILY_RELATIONS, relationId);
    if (!row || (row.studentIdA !== studentId && row.studentIdB !== studentId)) {
      throw new NotFoundException(`학생 ${studentId}의 가족 관계 ${relationId} 없음`);
    }
    return row;
  }

  private normalizeFamilyRelation(
    relationType: StudentFamilyRelation['relationType'],
    relationLabel?: string | null,
  ): Pick<StudentFamilyRelation, 'relationType' | 'relationLabel'> {
    const label = relationLabel?.trim() || null;
    if (relationType === 'other' && !label) throw new BadRequestException('기타 가족 관계명은 필수입니다.');
    if (relationType === 'sibling' && label) throw new BadRequestException('형제/자매 관계에는 기타 관계명을 입력할 수 없습니다.');
    return { relationType, relationLabel: relationType === 'other' ? label : null };
  }

  private academicHistoryForStudent(studentId: number, historyId: number): StudentAcademicHistory {
    this.findOne(studentId);
    const row = this.db.findById<StudentAcademicHistory>(STUDENT_ACADEMIC_HISTORIES, historyId);
    if (!row || row.studentId !== studentId) throw new NotFoundException(`학생 ${studentId}의 학교/학년 이력 ${historyId} 없음`);
    return row;
  }

  private normalizeAcademicHistory(input: {
    grade: number; schoolName: string; startedOn: string; endedOn?: string | null;
  }): Pick<StudentAcademicHistory, 'grade' | 'schoolName' | 'startedOn' | 'endedOn'> {
    const schoolName = input.schoolName.trim();
    const endedOn = input.endedOn || null;
    if (!schoolName) throw new BadRequestException('학교 이름은 공백일 수 없습니다.');
    if (input.grade < 0 || input.grade > 13) throw new BadRequestException('학년은 Kinder(0)부터 G13까지입니다.');
    if (endedOn && input.startedOn > endedOn) throw new BadRequestException('학교/학년 이력 종료일은 시작일보다 빠를 수 없습니다.');
    return { grade: input.grade, schoolName, startedOn: input.startedOn, endedOn };
  }

  private assertNoAcademicOverlap(
    studentId: number,
    candidate: Pick<StudentAcademicHistory, 'startedOn' | 'endedOn'>,
    excludeId?: number,
  ): void {
    const overlaps = this.db.findByField<StudentAcademicHistory>(STUDENT_ACADEMIC_HISTORIES, 'studentId', studentId)
      .some((row) => row.id !== excludeId
        && row.startedOn <= (candidate.endedOn ?? '9999-12-31')
        && (row.endedOn ?? '9999-12-31') >= candidate.startedOn);
    if (overlaps) throw new ConflictException('학교/학년 이력 기간이 기존 활성 구간과 겹칩니다.');
  }

  private async syncCurrentAcademicProjection(studentId: number, actorId: number, reason: string): Promise<void> {
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul' }).format(new Date());
    const current = this.db.findByField<StudentAcademicHistory>(STUDENT_ACADEMIC_HISTORIES, 'studentId', studentId)
      .filter((row) => row.startedOn <= today && (row.endedOn == null || row.endedOn >= today))
      .sort((a, b) => b.startedOn.localeCompare(a.startedOn) || b.id - a.id)[0];
    if (!current) return;
    const before = { ...this.findOne(studentId) };
    if (before.grade === current.grade && before.schoolName === current.schoolName) return;
    const gradeError = studentGradeBirthDateError(current.grade, before.birthDate);
    if (gradeError) throw new BadRequestException(gradeError);
    const after = await this.store.update<Student>(STUDENTS_SPEC, studentId, {
      grade: current.grade, schoolName: current.schoolName,
    });
    await this.audit.log({
      entity: STUDENTS, entityId: studentId, action: 'update', actorId,
      changes: this.audit.diffOf(before, after as Student), reason,
    });
  }

  async create(dto: CreateStudentDto, actorId?: number): Promise<Student> {
    const gradeError = studentGradeBirthDateError(dto.grade, dto.birthDate);
    if (gradeError) throw new BadRequestException(gradeError);
    return this.uow.run(async () => {
      const row = await this.store.insert<Student>(STUDENTS_SPEC, {
        name: dto.name,
        englishName: dto.englishName,
        gender: dto.gender,
        birthDate: dto.birthDate,
        phone: dto.phone,
        grade: dto.grade,
        schoolName: dto.schoolName,
        residenceType: dto.residenceType ?? 'domestic',
        address: dto.address,
        addressDetail: dto.addressDetail,
        kakaoId: dto.kakaoId,
        counselTopic: dto.counselTopic,
        status: dto.status ?? 'new_inquiry',
        country: dto.country,
        memo: dto.memo,
      });
      // 생성 당시의 비민감 값은 복원 가능한 이력으로 남기고 학생 PII는 키 단위 마스킹한다.
      if (actorId != null) {
        await this.audit.log({
          entity: 'students', entityId: row.id, action: 'create', actorId,
          changes: this.audit.maskContactPii(this.audit.diffOf({}, row)),
        });
      }
      return row;
    });
  }

  // 부분 수정 — 업무 상태 전이는 status_change audit, 삭제는 remove의 deleted_at 경로로 완전히 분리한다.
  async update(id: number, dto: UpdateStudentDto, actorId?: number): Promise<Student> {
    // ⚠ live-reference 함정: findOne은 메모리 행 참조를 그대로 주므로 update가 before까지 바꾼다 — 클론 필수.
    const before = { ...this.findOne(id) };
    const merged = { ...before, ...dto };
    const gradeError = studentGradeBirthDateError(merged.grade, merged.birthDate);
    if (gradeError) throw new BadRequestException(gradeError);
    return this.uow.run(async () => {
      const after = await this.store.update<Student>(STUDENTS_SPEC, id, { ...dto }) as Student;
      // 상태 변경과 일반 프로필 수정을 감사 action에서도 분리한다.
      if (actorId != null) {
        await this.audit.log({
          entity: 'students', entityId: id, action: before.status !== after.status ? 'status_change' : 'update', actorId,
          changes: this.audit.maskContactPii(this.audit.diffOf(before, after)),
        });
      }
      return after;
    });
  }

  async remove(id: number, actorId?: number): Promise<Student> {
    // [원자성] 학생·희망 수업·보호자 관계 soft delete + 활성 수강 canceled(부분 정리 잔존 금지).
    //  [TBO-29D D0 버그수정 2026-07-15] 수강 취소가 db.update(메모리 전용)로만 쓰여 PG에 미영속 —
    //  재기동/재수화 시 취소가 되살아나는 실버그(메모리 read model만 읽는 e2e는 통과해 왔다).
    //  uow.run(메모리 tx ⊃ PG tx) + student advisory lock + ENROLLMENTS_SPEC write-through로 교체:
    //  중간 실패 시 두 표 모두 롤백(부분 정리 잔존 금지 규약을 PG까지 확장).
    return this.uow.run(async () => {
      await this.uow.lockTargets([{ kind: 'student', id }]);
      const student = this.db.findById<Student>(STUDENTS, id);
      if (!student) throw new NotFoundException(`Student ${id} not found`);
      const before = { ...student };
      const enrollments = this.db.findBy<Enrollment>(ENROLLMENTS, (e) => e.studentId === id && e.status !== 'canceled');
      for (const e of enrollments) {
        const afterEnrollment = await this.store.update<Enrollment>(ENROLLMENTS_SPEC, e.id, { status: 'canceled' });
        if (actorId != null && afterEnrollment) await this.audit.log({
          entity: ENROLLMENTS, entityId: e.id, action: 'status_change', actorId,
          changes: this.audit.diffOf(e, afterEnrollment), reason: `student-delete:${id}`,
        });
      }
      const interests = this.db.findByField<StudentInterest>(STUDENT_INTERESTS, 'studentId', id);
      for (const interest of interests) {
        await this.store.remove(STUDENT_INTERESTS_SPEC, interest.id, actorId);
        if (actorId != null) await this.audit.log({
          entity: STUDENT_INTERESTS, entityId: interest.id, action: 'delete', actorId,
          changes: this.audit.snapshotOf(interest), reason: `student-delete:${id}`,
        });
      }
      const relations = this.db.findByField<ParentStudent>(PARENT_STUDENTS, 'studentId', id);
      for (const relation of relations) {
        await this.store.remove(PARENT_STUDENT_RELATIONS_SPEC, relation.id, actorId);
        if (actorId != null) await this.audit.log({
          entity: PARENT_STUDENTS, entityId: relation.id, action: 'delete', actorId,
          changes: this.audit.snapshotOf(relation), reason: `student-delete:${id}`,
        });
      }
      const familyRelations = this.db.findBy<StudentFamilyRelation>(STUDENT_FAMILY_RELATIONS, (row) =>
        row.studentIdA === id || row.studentIdB === id);
      for (const relation of familyRelations) {
        await this.store.remove(STUDENT_FAMILY_RELATIONS_SPEC, relation.id, actorId);
        if (actorId != null) await this.audit.log({
          entity: STUDENT_FAMILY_RELATIONS, entityId: relation.id, action: 'delete', actorId,
          changes: this.audit.snapshotOf(relation), reason: `student-delete:${id}`,
        });
      }
      const academicHistories = this.db.findByField<StudentAcademicHistory>(STUDENT_ACADEMIC_HISTORIES, 'studentId', id);
      for (const history of academicHistories) {
        await this.store.remove(STUDENT_ACADEMIC_HISTORIES_SPEC, history.id, actorId);
        if (actorId != null) await this.audit.log({
          entity: STUDENT_ACADEMIC_HISTORIES, entityId: history.id, action: 'delete', actorId,
          changes: this.audit.snapshotOf(history), reason: `student-delete:${id}`,
        });
      }
      await this.store.remove(STUDENTS_SPEC, id, actorId);
      const after = this.db.findById<Student>(STUDENTS, id, { withDeleted: true })!;
      if (actorId != null) {
        await this.audit.log({
          entity: STUDENTS, entityId: id, action: 'delete', actorId,
          changes: this.audit.maskContactPii(this.audit.snapshotOf(before)),
          reason: `cascade interests=${interests.length};guardians=${relations.length};family=${familyRelations.length};academic=${academicHistories.length};enrollments=${enrollments.length}`,
        });
      }
      return after;
    });
  }
}
