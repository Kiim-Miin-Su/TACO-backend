import { Injectable, OnModuleInit } from '@nestjs/common';
import { InMemoryDatabase } from '../../database/in-memory.database';
import { CounselForm, CounselRound, COUNSEL_FORMS, COUNSEL_ROUNDS } from './counsel.entity';

@Injectable()
export class CounselService implements OnModuleInit {
  constructor(private readonly db: InMemoryDatabase) {}

  // 데모 상담 시드 — 프론트 목데이터 이관. rounds.counselFormId→forms.id(무결성).
  // 상담 탭 배지: status≠dropped ∧ nextContactAt 없음(다음 상담일 미정) 기준.
  onModuleInit(): void {
    if (this.db.findAll<CounselForm>(COUNSEL_FORMS).length) return;
    this.db.seed<CounselForm>(COUNSEL_FORMS, [
      { id: 1, applicantName: '한서진', applicantPhone: '010-7777-1212', assignedStaffId: 1, status: 'pending', source: 'internal_form', interestSubjectId: 1, academyExpectation: '내신·수능 영어 전반 보완, 독해 속도 개선', desiredStartTime: 'within_1_month', learningAtmosphere: 'needs_management', studentIntention: 'parent_only', weakness: '독해 속도, 어휘량 부족', nextContactAt: '2026-06-29' },
      { id: 2, applicantName: '오민재', applicantPhone: '010-8888-3434', assignedStaffId: 1, status: 'registered', source: 'naver_form', interestCourseId: 11, interestSubjectId: 2, academyExpectation: 'AP Calculus 대비', desiredStartTime: 'immediately', learningAtmosphere: 'self_directed', studentIntention: 'student_wants', weakness: '서술형 풀이 과정' },
      { id: 3, applicantName: '신유나', applicantPhone: '010-9999-5656', status: 'requested', source: 'manual', interestSubjectId: 1, desiredStartTime: 'undecided', studentIntention: 'unknown' },
    ]);
    this.db.seed<CounselRound>(COUNSEL_ROUNDS, [
      { id: 1, counselFormId: 1, roundNo: 0, counselorId: 1, completedAt: '2026-06-19', isCompleted: true, summary: '초기 전화 상담', detail: '현 성적·목표 파악. 레벨테스트 권유.', result: 'neutral', nextAction: '레벨테스트 일정 조율', nextContactAt: '2026-06-23' },
      { id: 2, counselFormId: 1, roundNo: 1, counselorId: 1, completedAt: '2026-06-24', isCompleted: true, summary: '레벨테스트 후 대면 상담', detail: '독해 보강 필요. SAT Reading 정규 제안.', result: 'positive', nextAction: '수강 등록 안내', nextContactAt: '2026-06-29' },
      { id: 3, counselFormId: 2, roundNo: 0, counselorId: 1, completedAt: '2026-06-13', isCompleted: true, summary: '온라인 상담', detail: 'AP 일정 및 커리큘럼 안내.', result: 'positive', nextAction: '시간표 확정' },
      { id: 4, counselFormId: 2, roundNo: 1, counselorId: 1, completedAt: '2026-06-16', isCompleted: true, summary: '등록 확정 상담', detail: 'AP Calculus BC 등록 결정.', result: 'registered', nextAction: '결제 및 반 배정' },
    ]);
  }

  findAllForms(): CounselForm[] {
    return this.db.findAll<CounselForm>(COUNSEL_FORMS);
  }

  findAllRounds(counselFormId?: number): CounselRound[] {
    return this.db.findBy<CounselRound>(COUNSEL_ROUNDS, (r) => counselFormId == null || r.counselFormId === counselFormId);
  }
}
