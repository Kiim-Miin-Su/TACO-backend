import { Injectable, NotFoundException, OnModuleInit } from '@nestjs/common';
import { InMemoryDatabase } from '../../database/in-memory.database';
import { STUDENTS_SPEC } from '../../database/calendar-asset-specs';
import { PostgresCollectionStore } from '../../database/postgres-collection.store';
import { Student, STUDENTS } from './student.entity';
import { Enrollment, ENROLLMENTS } from '../enrollments/enrollment.entity';
import { CreateStudentDto } from './dto/create-student.dto';
import { UpdateStudentDto } from './dto/update-student.dto';

@Injectable()
export class StudentsService implements OnModuleInit {
  constructor(
    private readonly db: InMemoryDatabase,
    private readonly store: PostgresCollectionStore,
  ) {}

  // 데모 학생 시드 — 프론트 목데이터를 백엔드로 이관(고정 id로 관계 정합 유지).
  // 프론트는 이제 이 데이터를 GET /students로 가져와 store에 적재(단일 소스: 백엔드).
  async onModuleInit(): Promise<void> {
    const hydrated = await this.store.hydrate<Student>(STUDENTS_SPEC);
    if (hydrated.length || this.db.findAll<Student>(STUDENTS).length) return;
    await this.store.seed<Student>(STUDENTS_SPEC, [
      { id: 1, name: '김서연', englishName: 'Sophia', grade: 11, residenceType: 'overseas', country: 'US', status: 'active' },
      { id: 2, name: '이준호', englishName: 'Daniel', grade: 12, residenceType: 'domestic', country: 'KR', status: 'active' },
      { id: 3, name: '박지민', englishName: 'Emma', grade: 10, residenceType: 'overseas', country: 'VN', status: 'paused' },
      { id: 4, name: '최민준', englishName: 'Lucas', grade: 11, residenceType: 'domestic', status: 'active' },
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

  create(dto: CreateStudentDto): Promise<Student> {
    return this.store.insert<Student>(STUDENTS_SPEC, {
      name: dto.name,
      englishName: dto.englishName,
      phone: dto.phone,
      grade: dto.grade,
      schoolName: dto.schoolName,
      residenceType: dto.residenceType ?? 'domestic',
      status: dto.status ?? 'lead',
      country: dto.country,
      memo: dto.memo,
    });
  }

  // 소프트 삭제: 학생 상태를 canceled로, 해당 학생의 active 수강도 canceled로 정리(무결성).
  // [피드백 2026-07-03] 부분 수정 — 캘린더 우측 패널의 학생 정보 편집(국가·거주·상태·연락처 등).
  //  존재 검증 후 전달된 필드만 갱신(빈 body는 no-op). 퇴원(수강 동반 정리)은 remove가 담당.
  update(id: number, dto: UpdateStudentDto): Promise<Student> {
    this.findOne(id);
    return this.store.update<Student>(STUDENTS_SPEC, id, { ...dto }) as Promise<Student>;
  }

  async remove(id: number): Promise<Student> {
    // [원자성] 학생 소프트삭제 + 활성 수강 일괄 canceled(부분 정리 잔존 금지)
    return this.db.transaction(async () => {
    const student = this.db.findById<Student>(STUDENTS, id);
    if (!student) throw new NotFoundException(`Student ${id} not found`);
    const enrollments = this.db.findBy<Enrollment>(ENROLLMENTS, (e) => e.studentId === id);
    for (const e of enrollments) {
      this.db.update<Enrollment>(ENROLLMENTS, e.id, { status: 'canceled' });
    }
    return await this.store.update<Student>(STUDENTS_SPEC, id, { status: 'canceled' }) as Student;
  
    });
  }
}
