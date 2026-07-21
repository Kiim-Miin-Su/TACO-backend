import { BadRequestException, Injectable, NotFoundException, OnModuleInit } from '@nestjs/common';
import { InMemoryDatabase } from '../../database/in-memory.database';
import { ENROLLMENTS_SPEC, PARENT_STUDENT_RELATIONS_SPEC, STUDENT_INTERESTS_SPEC, STUDENTS_SPEC } from '../../database/calendar-asset-specs';
import { PostgresCollectionStore } from '../../database/postgres-collection.store';
import { CalendarUnitOfWork } from '../../database/calendar-unit-of-work.service';
import { AuditService } from '../audit/audit.service';
import { Student, STUDENTS } from './student.entity';
import { Enrollment, ENROLLMENTS } from '../enrollments/enrollment.entity';
import { CreateStudentDto } from './dto/create-student.dto';
import { UpdateStudentDto } from './dto/update-student.dto';
import { ParentStudent, PARENT_STUDENTS } from '../parents/parent.entity';
import { StudentInterest, STUDENT_INTERESTS } from './student-interest.entity';
import { studentGradeBirthDateError } from './student-grade.policy';

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
      await this.store.remove(STUDENTS_SPEC, id, actorId);
      const after = this.db.findById<Student>(STUDENTS, id, { withDeleted: true })!;
      if (actorId != null) {
        await this.audit.log({
          entity: STUDENTS, entityId: id, action: 'delete', actorId,
          changes: this.audit.maskContactPii(this.audit.snapshotOf(before)),
          reason: `cascade interests=${interests.length};relations=${relations.length};enrollments=${enrollments.length}`,
        });
      }
      return after;
    });
  }
}
