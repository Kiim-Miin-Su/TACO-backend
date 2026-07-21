import { Injectable, NotFoundException, OnModuleInit } from '@nestjs/common';
import { InMemoryDatabase } from '../../database/in-memory.database';
import { ENROLLMENTS_SPEC, STUDENTS_SPEC } from '../../database/calendar-asset-specs';
import { PostgresCollectionStore } from '../../database/postgres-collection.store';
import { CalendarUnitOfWork } from '../../database/calendar-unit-of-work.service';
import { AuditService } from '../audit/audit.service';
import { Student, STUDENTS } from './student.entity';
import { Enrollment, ENROLLMENTS } from '../enrollments/enrollment.entity';
import { CreateStudentDto } from './dto/create-student.dto';
import { UpdateStudentDto } from './dto/update-student.dto';

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
      { id: 1, name: '김서연', englishName: 'Sophia', grade: 11, residenceType: 'overseas', country: 'US', status: 'enrolled' },
      { id: 2, name: '이준호', englishName: 'Daniel', grade: 12, residenceType: 'domestic', country: 'KR', status: 'enrolled' },
      { id: 3, name: '박지민', englishName: 'Emma', grade: 10, residenceType: 'overseas', country: 'VN', status: 'on_leave' },
      { id: 4, name: '최민준', englishName: 'Lucas', grade: 11, residenceType: 'domestic', status: 'enrolled' },
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

  // 호환 DELETE: 학생을 퇴원 상태로 전이하고 해당 학생의 active 수강도 canceled로 정리한다.
  // status와 deleted_at을 분리한 실제 soft delete는 TBO-35C aggregate CRUD에서 전환한다.
  // [피드백 2026-07-03] 부분 수정 — 캘린더 우측 패널의 학생 정보 편집(국가·거주·상태·연락처 등).
  //  존재 검증 후 전달된 필드만 갱신(빈 body는 no-op). 퇴원(수강 동반 정리)은 remove가 담당.
  async update(id: number, dto: UpdateStudentDto, actorId?: number): Promise<Student> {
    // ⚠ live-reference 함정: findOne은 메모리 행 참조를 그대로 주므로 update가 before까지 바꾼다 — 클론 필수.
    const before = { ...this.findOne(id) };
    return this.uow.run(async () => {
      const after = await this.store.update<Student>(STUDENTS_SPEC, id, { ...dto }) as Student;
      // [감사 전수 2026-07-16] 수정 diff — phone 등 연락처 키는 마스킹(maskContactPii).
      if (actorId != null) {
        await this.audit.log({
          entity: 'students', entityId: id, action: 'update', actorId,
          changes: this.audit.maskContactPii(this.audit.diffOf(before, after)),
        });
      }
      return after;
    });
  }

  async remove(id: number, actorId?: number): Promise<Student> {
    // [원자성] 학생 소프트삭제 + 활성 수강 일괄 canceled(부분 정리 잔존 금지).
    //  [TBO-29D D0 버그수정 2026-07-15] 수강 취소가 db.update(메모리 전용)로만 쓰여 PG에 미영속 —
    //  재기동/재수화 시 취소가 되살아나는 실버그(메모리 read model만 읽는 e2e는 통과해 왔다).
    //  uow.run(메모리 tx ⊃ PG tx) + student advisory lock + ENROLLMENTS_SPEC write-through로 교체:
    //  중간 실패 시 두 표 모두 롤백(부분 정리 잔존 금지 규약을 PG까지 확장).
    return this.uow.run(async () => {
      await this.uow.lockTargets([{ kind: 'student', id }]);
      const student = this.db.findById<Student>(STUDENTS, id);
      if (!student) throw new NotFoundException(`Student ${id} not found`);
      const beforeStatus = student.status; // live-reference — update 전에 캡처
      const enrollments = this.db.findBy<Enrollment>(ENROLLMENTS, (e) => e.studentId === id && e.status !== 'canceled');
      for (const e of enrollments) {
        await this.store.update<Enrollment>(ENROLLMENTS_SPEC, e.id, { status: 'canceled' });
      }
      const after = (await this.store.update<Student>(STUDENTS_SPEC, id, { status: 'withdrawn' })) as Student;
      // [감사 전수 2026-07-16] 퇴원(소프트삭제) + 동반 수강 취소를 한 이력으로.
      if (actorId != null) {
        await this.audit.log({
          entity: 'students', entityId: id, action: 'status_change', actorId,
          changes: { status: { before: beforeStatus, after: 'withdrawn' }, canceledEnrollmentIds: { after: enrollments.map((e) => e.id) } },
        });
      }
      return after;
    });
  }
}
