import { Injectable, NotFoundException } from '@nestjs/common';
import { InMemoryDatabase } from '../../database/in-memory.database';
import { Course, COURSES } from './course.entity';
import { CreateCourseDto } from './dto/create-course.dto';

@Injectable()
export class CoursesService {
  constructor(private readonly db: InMemoryDatabase) {}

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
