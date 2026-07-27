import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import { guardianKey, onlyDigits } from '../../common/digits.util'; // [P2 4-A/B]
import type { StudentAggregate } from '@kms545487/contracts';
import { CalendarUnitOfWork } from '../../database/calendar-unit-of-work.service';
import { StudentsService } from '../students/students.service';
import { ParentsService } from '../parents/parents.service';
import { EnrollmentsService } from '../enrollments/enrollments.service';
import { AuditService } from '../audit/audit.service';
import type { Student } from '../students/student.entity';
import type { Parent, ParentStudent } from '../parents/parent.entity';
import type { Enrollment } from '../enrollments/enrollment.entity';
import { RegisterStudentDto } from './dto/register-student.dto';
import { StudentInterestsService } from '../students/student-interests.service';
import { UpdateStudentAggregateDto } from '../students/dto/update-student-aggregate.dto';
import { studentGradeBirthDateError } from '../students/student-grade.policy';
import type { InstructorStudentAggregate } from '../students/students.service';

export type RegistrationResult = {
  student: Student;
  guardian: { parent: Parent; relation: ParentStudent; linkedExisting: boolean } | null;
  guardians: Array<{ parent: Parent; relation: ParentStudent; linkedExisting: boolean }>;
  enrollment: Enrollment | null;
};

/**
 * [TBO-29D D2] 학생 aggregate 원자 등록 — student + optional guardian(parent upsert-or-link + relation)
 *  + optional enrollment + audit를 **하나의 uow tx**(메모리 tx ⊃ PG tx)로 저장한다.
 *  불변식(TBO-29D §3): 중간 실패 시 전부 +0 · 서버가 모든 id 발급 · write-through만 사용 ·
 *  PII(보호자 연락처)는 audit에 남기지 않는다(존재 플래그만).
 *  동시성: 보호자 전화 기준 parentIntake advisory lock — 같은 번호 동시 등록도 보호자 1행 보장.
 *  별도 모듈인 이유: StudentsService↔ParentsService 순환 의존 회피(Parents가 Students를 import).
 */
@Injectable()
export class RegistrationsService {
  constructor(
    private readonly uow: CalendarUnitOfWork,
    private readonly students: StudentsService,
    private readonly parents: ParentsService,
    private readonly interests: StudentInterestsService,
    private readonly enrollments: EnrollmentsService,
    private readonly audit: AuditService,
  ) {}

  async register(dto: RegisterStudentDto, actorId: number): Promise<RegistrationResult> {
    return this.uow.run(async () => {
      if (dto.guardian && dto.guardians) throw new BadRequestException('guardian과 guardians를 동시에 사용할 수 없습니다.');
      const guardians = this.normalizeGuardians(dto.guardians ?? (dto.guardian ? [dto.guardian] : []));
      const studentInput = this.normalizeCompleteProfile(dto.student);
      // 학생 생성 전에 관심 target/FK/순서를 검증해 실패 요청이 id조차 발급하지 않도록 한다.
      await this.interests.reloadCommandState();
      this.interests.validate(dto.interests);
      const locks = guardians
        .map((guardian) => onlyDigits(guardian.phone ?? '')) // [P2 4-A]
        .filter(Boolean)
        .map((digits) => ({ kind: 'parentIntake' as const, id: phoneLockIdOf(digits) }));
      await this.uow.lockTargets(locks);

      const student = await this.students.create(studentInput, actorId);
      await this.interests.replaceInTx(student.id, dto.interests, actorId);
      // [감사 전수 2026-07-16] 전 테이블 CRUD 이력(대표 지시) — actorId 스레딩:
      //  attachGuardianInTx가 같은 tx 안에서 parents create + parent_student_relations create audit을 남긴다.
      const savedGuardians = [] as RegistrationResult['guardians'];
      for (const guardian of guardians) savedGuardians.push(await this.parents.attachGuardianInTx(student.id, guardian, actorId));
      const enrollment = dto.courseId != null
        ? await this.enrollments.create({ studentId: student.id, courseId: dto.courseId }, actorId)
        : null;

      // PII 금지 — 보호자 연락처/이름은 남기지 않고 구성 요약만(관계 행 id는 추적 가능 참조).
      await this.audit.log({
        entity: 'students',
        entityId: student.id,
        action: 'create',
        actorId,
        reason: 'registration(aggregate)',
        changes: this.audit.maskContactPii({
          student: { after: student },
          registration: {
            after: {
              guardianRelationIds: savedGuardians.map((entry) => entry.relation.id),
              linkedExistingCount: savedGuardians.filter((entry) => entry.linkedExisting).length,
              interestCount: dto.interests.length,
              enrollmentId: enrollment?.id ?? null,
              courseId: dto.courseId ?? null,
            },
          },
        }),
      });
      return { student, guardian: savedGuardians[0] ?? null, guardians: savedGuardians, enrollment };
    });
  }

  getAggregate(studentId: number): Promise<StudentAggregate> {
    return this.students.findAggregateDb(studentId); // [TBO-54 C2] DB 권위 READ
  }

  getAggregateForActor(
    studentId: number,
    actorId?: number,
    roles: string[] = [],
  ): Promise<StudentAggregate | InstructorStudentAggregate> {
    return this.students.findAggregateDbForActor(studentId, actorId, roles);
  }

  async updateAggregate(studentId: number, dto: UpdateStudentAggregateDto, actorId: number): Promise<StudentAggregate> {
    if (!dto.student && !dto.interests) throw new BadRequestException('student 또는 interests 변경이 필요합니다.');
    return this.uow.run(async () => {
      await this.uow.lockTargets([{ kind: 'student', id: studentId }]);
      await this.students.reloadCommandState();
      const before = this.students.findOne(studentId);
      // 관심 수업을 실제로 바꿀 때만 해당 aggregate를 DB에서 다시 읽고 검증한다.
      // 상태-only PATCH가 오래된/무관한 course cache에 의존하지 않게 한다.
      if (dto.interests) {
        await this.interests.reloadCommandState();
        this.interests.validate(dto.interests);
      }
      if (dto.student) {
        // [TBO-62 후속 2026-07-24] 부분 수정은 부분 검증 — 종전엔 merged 전체를 완전-필수 검증해,
        //  필수 필드가 비어 있는 기존(레거시) 원부는 status만 바꾸는 퇴원 처리조차 400으로 거부됐다
        //  (운영 실측: "매니저가 퇴원 처리 불가" — 권한이 아니라 검증 결함). 이제 ① 패치가 건드리는
        //  필수 필드를 빈 값으로 지우는 것만 금지 ② 교차 규칙(국가↔카카오·거주 유형·학년↔생년월일)은
        //  관련 필드가 패치에 있을 때만 merged 기준으로 검증. 신규 등록(register)은 종전 완전 검증 유지.
        this.normalizePartialProfile(before as unknown as Record<string, unknown>, dto.student as unknown as Record<string, unknown>);
        const patch = {
          ...dto.student,
          ...(dto.student.country != null
            ? { residenceType: dto.student.country === 'KR' ? 'domestic' as const : 'overseas' as const }
            : {}),
        };
        await this.students.update(studentId, patch, actorId);
      }
      if (dto.interests) await this.interests.replaceInTx(studentId, dto.interests, actorId);
      return this.getAggregate(studentId);
    });
  }

  /** [TBO-62 후속] 부분 patch 검증 — 레거시 미비 원부에도 status 등 부분 변경을 허용한다. */
  private normalizePartialProfile(
    before: Record<string, unknown>,
    patch: Record<string, unknown>,
  ): void {
    const requiredLabels: Record<string, string> = {
      name: '학생 이름', gender: '성별', birthDate: '생년월일', grade: '학년', country: '현 거주 국가',
      address: '현 거주지', schoolName: '재학 학교', phone: '연락처', counselTopic: '상담 주제',
    };
    const cleared = Object.entries(requiredLabels)
      .filter(([key]) => key in patch)
      .filter(([key]) => {
        const value = patch[key];
        return value == null || (typeof value === 'string' && !value.trim());
      })
      .map(([, label]) => label);
    if (cleared.length) throw new BadRequestException(`필수 학생 정보는 비울 수 없습니다: ${cleared.join(', ')}`);

    const merged = { ...before, ...patch } as {
      country?: string; kakaoId?: string; residenceType?: string; grade?: number; birthDate?: string;
    };
    if (('country' in patch || 'kakaoId' in patch) && merged.country && merged.country.trim() !== 'KR' && !merged.kakaoId?.trim()) {
      throw new BadRequestException('해외 거주 학생은 카카오톡 ID가 필수입니다.');
    }
    if (('country' in patch || 'residenceType' in patch) && merged.country && merged.residenceType) {
      const expected = merged.country.trim() === 'KR' ? 'domestic' : 'overseas';
      // country 변경 시 patch 파생이 residenceType을 덮으므로, 명시 불일치 입력만 거른다.
      if ('residenceType' in patch && merged.residenceType !== expected) {
        throw new BadRequestException('거주 유형과 국가가 일치하지 않습니다.');
      }
    }
    if (('grade' in patch || 'birthDate' in patch) && merged.grade != null && merged.birthDate) {
      const gradeError = studentGradeBirthDateError(merged.grade, merged.birthDate);
      if (gradeError) throw new BadRequestException(gradeError);
    }
  }

  private normalizeCompleteProfile<T extends {
    name?: string; gender?: string; birthDate?: string; grade?: number; country?: string; address?: string;
    schoolName?: string; phone?: string; kakaoId?: string; counselTopic?: string; residenceType?: string;
  }>(input: T): T & { residenceType: 'domestic' | 'overseas' } {
    const required: Array<[string, unknown]> = [
      ['학생 이름', input.name], ['성별', input.gender], ['생년월일', input.birthDate], ['학년', input.grade],
      ['현 거주 국가', input.country], ['현 거주지', input.address], ['재학 학교', input.schoolName],
      ['연락처', input.phone], ['상담 주제', input.counselTopic],
    ];
    const missing = required.filter(([, value]) => value == null || (typeof value === 'string' && !value.trim())).map(([label]) => label);
    if (missing.length) throw new BadRequestException(`필수 학생 정보가 누락되었습니다: ${missing.join(', ')}`);
    const country = input.country!.trim();
    if (country !== 'KR' && !input.kakaoId?.trim()) throw new BadRequestException('해외 거주 학생은 카카오톡 ID가 필수입니다.');
    const residenceType = country === 'KR' ? 'domestic' : 'overseas';
    if (input.residenceType && input.residenceType !== residenceType) {
      throw new BadRequestException('거주 유형과 국가가 일치하지 않습니다.');
    }
    const gradeError = studentGradeBirthDateError(input.grade, input.birthDate);
    if (gradeError) throw new BadRequestException(gradeError);
    return { ...input, residenceType };
  }

  private normalizeGuardians<T extends { name: string; phone?: string; isPrimary?: boolean }>(guardians: T[]): Array<T & { isPrimary: boolean }> {
    if (guardians.filter((guardian) => guardian.isPrimary).length > 1) throw new ConflictException('주보호자는 최대 1명입니다.');
    const normalized = guardians.map((guardian, index) => ({ ...guardian, isPrimary: guardians.some((item) => item.isPrimary) ? guardian.isPrimary === true : index === 0 }));
    const keys = normalized.map((guardian) => guardianKey(guardian.name, guardian.phone ?? '')); // [P2 4-B] FE identity.guardianKey와 동형(계약 테스트 고정)
    if (new Set(keys).size !== keys.length) throw new ConflictException('중복된 보호자 입력이 있습니다.');
    return normalized;
  }
}

/** 숫자 문자열 → 31-bit 양수(advisory lock objid) — FNV-1a 변형, 프로세스/인스턴스 무관 결정적. */
export function phoneLockIdOf(digits: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < digits.length; i += 1) {
    h ^= digits.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 1) || 1; // 0 회피(잠금 id 규약)
}
