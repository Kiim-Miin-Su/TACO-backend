import { Injectable, NotFoundException } from '@nestjs/common';
import { InMemoryDatabase } from '../../database/in-memory.database';
import { Subject, SUBJECTS } from './subject.entity';
import { CreateSubjectDto } from './dto/create-subject.dto';

@Injectable()
export class SubjectsService {
  constructor(private readonly db: InMemoryDatabase) {}

  findAll(): Subject[] {
    return this.db.findAll<Subject>(SUBJECTS);
  }

  findOne(id: number): Subject {
    const row = this.db.findById<Subject>(SUBJECTS, id);
    if (!row) throw new NotFoundException(`Subject ${id} not found`);
    return row;
  }

  create(dto: CreateSubjectDto): Subject {
    return this.db.insert<Subject>(SUBJECTS, { code: dto.code, name: dto.name });
  }
}
