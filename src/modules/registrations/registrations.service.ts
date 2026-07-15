import { Injectable } from '@nestjs/common';
import { CalendarUnitOfWork } from '../../database/calendar-unit-of-work.service';
import { StudentsService } from '../students/students.service';
import { ParentsService } from '../parents/parents.service';
import { EnrollmentsService } from '../enrollments/enrollments.service';
import { AuditService } from '../audit/audit.service';
import type { Student } from '../students/student.entity';
import type { Parent, ParentStudent } from '../parents/parent.entity';
import type { Enrollment } from '../enrollments/enrollment.entity';
import { RegisterStudentDto } from './dto/register-student.dto';

export type RegistrationResult = {
  student: Student;
  guardian: { parent: Parent; relation: ParentStudent; linkedExisting: boolean } | null;
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
    private readonly enrollments: EnrollmentsService,
    private readonly audit: AuditService,
  ) {}

  async register(dto: RegisterStudentDto, actorId: number): Promise<RegistrationResult> {
    return this.uow.run(async () => {
      // 전화번호 → 31-bit 결정적 lock id(FNV-1a). 같은 보호자 번호의 등록을 직렬화한다.
      const phoneDigits = (dto.guardian?.phone ?? '').replace(/\D/g, '');
      if (phoneDigits) await this.uow.lockTargets([{ kind: 'parentIntake', id: phoneLockIdOf(phoneDigits) }]);

      const student = await this.students.create(dto.student);
      const guardian = dto.guardian ? await this.parents.attachGuardianInTx(student.id, dto.guardian) : null;
      const enrollment = dto.courseId != null
        ? await this.enrollments.create({ studentId: student.id, courseId: dto.courseId })
        : null;

      // PII 금지 — 보호자 연락처/이름은 남기지 않고 구성 요약만(관계 행 id는 추적 가능 참조).
      await this.audit.log({
        entity: 'students',
        entityId: student.id,
        action: 'create',
        actorId,
        reason: 'registration(aggregate)',
        changes: {
          registration: {
            after: {
              guardianRelationId: guardian?.relation.id ?? null,
              guardianLinkedExisting: guardian?.linkedExisting ?? false,
              enrollmentId: enrollment?.id ?? null,
              courseId: dto.courseId ?? null,
            },
          },
        },
      });
      return { student, guardian, enrollment };
    });
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
