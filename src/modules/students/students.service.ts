import { Injectable, NotFoundException } from '@nestjs/common';
import { InMemoryDatabase } from '../../database/in-memory.database';
import { Student, STUDENTS } from './student.entity';
import { CreateStudentDto } from './dto/create-student.dto';

@Injectable()
export class StudentsService {
  constructor(private readonly db: InMemoryDatabase) {}

  findAll(): Student[] {
    return this.db.findAll<Student>(STUDENTS);
  }

  findOne(id: number): Student {
    const student = this.db.findById<Student>(STUDENTS, id);
    if (!student) throw new NotFoundException(`Student ${id} not found`);
    return student;
  }

  create(dto: CreateStudentDto): Student {
    return this.db.insert<Student>(STUDENTS, {
      name: dto.name,
      englishName: dto.englishName,
      phone: dto.phone,
      grade: dto.grade,
      schoolName: dto.schoolName,
      residenceType: dto.residenceType ?? 'domestic',
      status: dto.status ?? 'lead',
      memo: dto.memo,
    });
  }
}
