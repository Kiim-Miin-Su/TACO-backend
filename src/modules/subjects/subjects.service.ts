import { Injectable, NotFoundException, OnModuleInit } from '@nestjs/common';
import { InMemoryDatabase } from '../../database/in-memory.database';
import { Subject, SUBJECTS } from './subject.entity';
import { CreateSubjectDto } from './dto/create-subject.dto';

@Injectable()
export class SubjectsService implements OnModuleInit {
  constructor(private readonly db: InMemoryDatabase) {}

  // 데모 과목 시드 — 스케줄 모듈 SUBJECTS 라벨(1:영어, 2:수학)과 id 정렬.
  // courses.subjectId → subjects.id 조인 무결성의 단일 소스.
  onModuleInit(): void {
    this.db.seed<Subject>(SUBJECTS, [
      { id: 1, code: 'english', name: '영어' },
      { id: 2, code: 'math', name: '수학' },
    ]);
  }

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
