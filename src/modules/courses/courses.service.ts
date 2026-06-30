import { Injectable, NotFoundException, OnModuleInit } from '@nestjs/common';
import { InMemoryDatabase } from '../../database/in-memory.database';
import { Course, COURSES } from './course.entity';
import { CreateCourseDto } from './dto/create-course.dto';

@Injectable()
export class CoursesService implements OnModuleInit {
  constructor(private readonly db: InMemoryDatabase) {}

  // 데모 코스 시드 — 스케줄 모듈 COURSES(10,11,12)와 id·강사·과목·색 정렬.
  // hourlyRate(시급)는 페이 산정의 기준값으로, class_sessions.courseId → courses.id
  // 조인의 단일 소스. 세션이 참조하는 코스 id를 고정해 FK/조인 무결성을 보장한다.
  onModuleInit(): void {
    this.db.seed<Course>(COURSES, [
      { id: 10, name: 'SAT Reading 정규', subjectId: 1, instructorId: 1, price: 600000, hourlyRate: 50000, color: '#0969da' },
      { id: 11, name: 'AP Calculus BC', subjectId: 2, instructorId: 2, price: 720000, hourlyRate: 60000, color: '#8250df' },
      { id: 12, name: 'TOEFL 정규', subjectId: 1, instructorId: 1, price: 500000, hourlyRate: 45000, color: '#1b7c83' },
    ]);
  }

  findAll(): Course[] {
    return this.db.findAll<Course>(COURSES);
  }

  findOne(id: number): Course {
    const row = this.db.findById<Course>(COURSES, id);
    if (!row) throw new NotFoundException(`Course ${id} not found`);
    return row;
  }

  create(dto: CreateCourseDto): Course {
    return this.db.insert<Course>(COURSES, {
      name: dto.name,
      subjectId: dto.subjectId,
      instructorId: dto.instructorId,
      price: dto.price,
      hourlyRate: dto.hourlyRate,
      color: dto.color,
    });
  }
}
