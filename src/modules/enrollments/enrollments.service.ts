import { BadRequestException, Injectable, NotFoundException, OnModuleInit } from '@nestjs/common';
import { InMemoryDatabase } from '../../database/in-memory.database';
import { Enrollment, ENROLLMENTS } from './enrollment.entity';
import { CreateEnrollmentDto } from './dto/create-enrollment.dto';
import { STUDENTS } from '../students/student.entity';
import { COURSES } from '../courses/course.entity';

@Injectable()
export class EnrollmentsService implements OnModuleInit {
  constructor(private readonly db: InMemoryDatabase) {}

  // 데모 수강 시드 — 프론트 목데이터 이관. studentId→students, courseId→courses(무결성).
  // completedSessions는 진행완료(held) 세션 수와 정합(코스10/11/12 각 2회).
  onModuleInit(): void {
    if (this.db.findAll<Enrollment>(ENROLLMENTS).length) return;
    this.db.seed<Enrollment>(ENROLLMENTS, [
      { id: 1, studentId: 1, courseId: 10, status: 'active', totalSessions: 16, completedSessions: 2, enrolledAt: '2026-06-17' },
      { id: 2, studentId: 2, courseId: 11, status: 'active', totalSessions: 20, completedSessions: 2, enrolledAt: '2026-06-16' },
      { id: 3, studentId: 4, courseId: 10, status: 'active', totalSessions: 16, completedSessions: 2, enrolledAt: '2026-06-17' },
      { id: 4, studentId: 1, courseId: 12, status: 'active', totalSessions: 12, completedSessions: 2, enrolledAt: '2026-06-22' },
    ]);
  }

  findAll(): Enrollment[] {
    return this.db.findAll<Enrollment>(ENROLLMENTS);
  }

  findByStudent(studentId: number): Enrollment[] {
    return this.db.findBy<Enrollment>(ENROLLMENTS, (e) => e.studentId === studentId);
  }

  findOne(id: number): Enrollment {
    const row = this.db.findById<Enrollment>(ENROLLMENTS, id);
    if (!row) throw new NotFoundException(`Enrollment ${id} not found`);
    return row;
  }

  // 결제 없이도 등록 가능 (status=active)
  create(dto: CreateEnrollmentDto): Enrollment {
    // [감사 H3] FK 존재 검증 — 고아 수강이 스케줄 코호트(activeStudentIds)에 유령 학생을 만드는 것 방지.
    if (!this.db.findById(STUDENTS, dto.studentId))
      throw new BadRequestException(`존재하지 않는 학생입니다 (studentId=${dto.studentId})`);
    if (!this.db.findById(COURSES, dto.courseId))
      throw new BadRequestException(`존재하지 않는 코스입니다 (courseId=${dto.courseId})`);
    return this.db.insert<Enrollment>(ENROLLMENTS, {
      studentId: dto.studentId,
      courseId: dto.courseId,
      roadmapId: dto.roadmapId,
      status: 'active',
      totalSessions: dto.totalSessions,
      completedSessions: 0,
      memo: dto.memo,
      enrolledAt: new Date().toISOString().slice(0, 10),
    });
  }
}
