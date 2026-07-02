import { BadRequestException, ConflictException, Injectable, NotFoundException, OnModuleInit } from '@nestjs/common';
import { InMemoryDatabase } from '../../database/in-memory.database';
import { Student, STUDENTS } from '../students/student.entity';
import { Parent, ParentStudent, PARENTS, PARENT_STUDENTS } from './parent.entity';
import { CreateParentDto } from './dto/create-parent.dto';
import { LinkParentDto, UpdateRelationDto } from './dto/link-parent.dto';

/**
 * [참조/처리] 보호자 + 학생↔보호자 M:N. 프론트 목데이터 이관 + 참조 무결성 게이트.
 *  - 시드: 보호자 3(김미경/이상철/최영희) + 관계 3(학생 1·2·4 각 대표 1명) — students 시드와 정합.
 *  무결성 3종:
 *   1) FK: parentId→parents, studentId→students 존재 검증(없으면 400).
 *   2) (parentId, studentId) 유니크: 같은 보호자-학생 중복 연결 금지(409).
 *   3) 대표(primary)는 학생당 최대 1명: 새 대표 지정 시 기존 대표 자동 강등(불변 유지).
 */
@Injectable()
export class ParentsService implements OnModuleInit {
  constructor(private readonly db: InMemoryDatabase) {}

  onModuleInit(): void {
    this.db.seed<Parent>(PARENTS, [
      { id: 1, name: '김미경', phone: '010-1111-2222', kakaoAvailable: true },
      { id: 2, name: '이상철', phone: '010-3333-4444', kakaoAvailable: true },
      { id: 3, name: '최영희', phone: '010-5555-6666', kakaoAvailable: false },
    ]);
    this.db.seed<ParentStudent>(PARENT_STUDENTS, [
      { id: 1, parentId: 1, studentId: 1, relation: '모', isPayer: true, isPrimary: true },
      { id: 2, parentId: 2, studentId: 2, relation: '부', isPayer: true, isPrimary: true },
      { id: 3, parentId: 3, studentId: 4, relation: '모', isPayer: true, isPrimary: true },
    ]);
  }

  findAll(): Parent[] {
    return this.db.findAll<Parent>(PARENTS);
  }

  findAllRelations(): ParentStudent[] {
    return this.db.findAll<ParentStudent>(PARENT_STUDENTS);
  }

  // 신규 보호자 + 학생 연결(intake).
  create(dto: CreateParentDto): { parent: Parent; relation: ParentStudent } {
    // [원자성] 보호자 생성 + 학생 연결(+기존 대표 강등)이 함께 — 고아 보호자/이중 대표 방지
    return this.db.transaction(() => {    if (!this.db.findById<Student>(STUDENTS, dto.studentId))
      throw new BadRequestException(`studentId ${dto.studentId} 없음(존재하지 않는 학생)`);
    const parent = this.db.insert<Parent>(PARENTS, {
      name: dto.name,
      phone: dto.phone ?? '',
      kakaoAvailable: false,
      webId: dto.webId,
    });
    const relation = this.link({
      parentId: parent.id,
      studentId: dto.studentId,
      relation: dto.relation,
      isPayer: dto.isPayer,
      isPrimary: dto.isPrimary,
    });
    return { parent, relation };
      });
  }

  // 기존 보호자를 학생에 연결(형제 등 M:N). FK·유니크·대표 불변 강제.
  link(dto: LinkParentDto): ParentStudent {
    if (!this.db.findById<Parent>(PARENTS, dto.parentId))
      throw new BadRequestException(`parentId ${dto.parentId} 없음(존재하지 않는 보호자)`);
    if (!this.db.findById<Student>(STUDENTS, dto.studentId))
      throw new BadRequestException(`studentId ${dto.studentId} 없음(존재하지 않는 학생)`);

    const dup = this.db.findBy<ParentStudent>(
      PARENT_STUDENTS,
      (r) => r.parentId === dto.parentId && r.studentId === dto.studentId,
    );
    if (dup.length) throw new ConflictException(`보호자 ${dto.parentId}·학생 ${dto.studentId} 연결이 이미 존재`);

    if (dto.isPrimary) this.demotePrimary(dto.studentId);
    return this.db.insert<ParentStudent>(PARENT_STUDENTS, {
      parentId: dto.parentId,
      studentId: dto.studentId,
      relation: dto.relation,
      isPayer: dto.isPayer ?? false,
      isPrimary: dto.isPrimary ?? false,
    });
  }

  // 관계 수정(대표 이전·납부자). 대표 지정 시 기존 대표 강등 → 학생당 대표 ≤1 유지.
  updateRelation(id: number, dto: UpdateRelationDto): ParentStudent {
    const rel = this.db.findById<ParentStudent>(PARENT_STUDENTS, id);
    if (!rel) throw new NotFoundException(`관계 ${id} 없음`);
    if (dto.isPrimary === true) this.demotePrimary(rel.studentId, id);
    return this.db.update<ParentStudent>(PARENT_STUDENTS, id, {
      ...(dto.relation !== undefined ? { relation: dto.relation } : {}),
      ...(dto.isPayer !== undefined ? { isPayer: dto.isPayer } : {}),
      ...(dto.isPrimary !== undefined ? { isPrimary: dto.isPrimary } : {}),
    }) as ParentStudent;
  }

  // 학생의 기존 대표(primary)를 모두 강등(exceptId는 유지). 대표 불변 보장의 핵심.
  private demotePrimary(studentId: number, exceptId?: number): void {
    this.db
      .findBy<ParentStudent>(PARENT_STUDENTS, (r) => r.studentId === studentId && r.isPrimary && r.id !== exceptId)
      .forEach((r) => this.db.update<ParentStudent>(PARENT_STUDENTS, r.id, { isPrimary: false }));
  }
}
