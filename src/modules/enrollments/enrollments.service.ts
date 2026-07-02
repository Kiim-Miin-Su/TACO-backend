import { Injectable, NotFoundException } from '@nestjs/common';
import { InMemoryDatabase } from '../../database/in-memory.database';
import { Enrollment, ENROLLMENTS } from './enrollment.entity';
import { CreateEnrollmentDto } from './dto/create-enrollment.dto';

@Injectable()
export class EnrollmentsService {
  constructor(private readonly db: InMemoryDatabase) {}

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
