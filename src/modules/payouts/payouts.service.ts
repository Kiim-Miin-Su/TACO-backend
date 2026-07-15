import { BadRequestException, ConflictException, Injectable, NotFoundException, OnModuleInit } from '@nestjs/common';
import { InMemoryDatabase } from '../../database/in-memory.database';
import { INSTRUCTOR_PAYOUTS_SPEC, TRANSACTIONS_SPEC } from '../../database/calendar-asset-specs';
import { PostgresCollectionStore } from '../../database/postgres-collection.store';
import { hhmmToMin, minToHhmm } from '../../common/time.util'; // [R-3 함수 통일]
import { ClassSession, SESSIONS } from '../schedule/schedule.entity';
import { ClassSessionsStore } from '../schedule/class-sessions.store';
import { countsForTeachingHours, payoutAmountOf } from '../schedule/session-accounting.policy';
import { CalendarUnitOfWork } from '../../database/calendar-unit-of-work.service';
import { Course, COURSES } from '../courses/course.entity';
import { ReportsService } from '../reports/reports.service';
import { demoSeedEnabled } from '../../config/demo-seed';
import {
  InstructorPayoutRow,
  PayoutLine,
  PAYOUTS,
  TransactionRow,
} from './payout.entity';

// 세션 행은 정산 연결 후 payoutId/페이 스냅샷을 갖는다(ERD class_sessions).
type SessionWithPayout = ClassSession & { payoutId?: number; instructorPayAmount?: number };

export type MeasureResult = {
  instructorId: number;
  periodStart: string;
  periodEnd: string;
  sessionCount: number;
  totalMinutes: number;
  computedAmount: number;
  lines: PayoutLine[];
};

/**
 * 시수 측정 + 페이 정산.
 *
 * 시수 적격성(참조 무결성 게이트, 모두 충족해야 시수가 채워짐):
 *   1) 세션이 실제 진행됨        → status === 'held'  (취소/노쇼/예정·보강 제외)
 *   1-b) 강사가 결석하지 않음      → instructorAttendance !== 'absent'  [TBO-19 시수 정책]
 *   2) 승인된 보고서 존재         → reports.approvalStatus === 'approved'
 *   3) 코스 FK 유효(시급 조인)    → courses.id 존재
 *   4) 다른 정산서에 미연결        → session.payoutId == null (이중 계상 방지)
 * 페이 = Σ round(durationMinutes / 60 × course.hourlyRate)
 *
 * ⚠ [TBO-19 시수 정책 · 2026-07-07 — 잠정 비즈니스 로직, 추후 변경]
 *   강사 결석·수업 미진행(취소/노쇼)·보강(makeup)은 우선 **시수 제외**(대표 결정). 지각은 인정(감산 없음).
 *   변경 시 FE `lib/domain/schedule.countsForPay`와 **동시** 수정(단일 규칙). 정책 문서=docs/TODO.md TBO-19.
 */
@Injectable()
export class PayoutsService implements OnModuleInit {
  constructor(
    private readonly db: InMemoryDatabase,
    private readonly store: PostgresCollectionStore,
    private readonly sessionsStore: ClassSessionsStore,
    private readonly reports: ReportsService,
    private readonly unitOfWork: CalendarUnitOfWork,
  ) {}

  // 데모 mock 주입 — 현재 주(週) 범위 밖(6월 중순)에 held 세션 + 승인 보고서를 심어
  // 프론트 /payouts 화면이 부팅 직후부터 실제 데이터로 동작하게 한다.
  //  · 강사1: 적격 3건(미정산) + 게이트 데모(보고서 없음·취소) → UI에서 산정/생성 시연
  //  · 강사2: 적격 3건 → generate→confirm→pay로 '지급완료' 정산서 + 원장 출금 1줄
  // 현재 주(MON~SUN)·강사1 쿼리와 겹치지 않게 6/8~6/19로 한정(e2e 불간섭).
  async onModuleInit(): Promise<void> {
    const hydrated = await this.store.hydrate<InstructorPayoutRow>(INSTRUCTOR_PAYOUTS_SPEC);
    if (hydrated.length) return; // 이미 DB에 저장됨
    // [시범운영 2026-07-15] 이 시드는 seed()가 아니라 insert/승인 흐름으로 데모를 만들어
    //  store.seed 단일 관문을 우회했다(production 부팅 테스트에서 FK 위반으로 검출) — 명시 게이트.
    if (!demoSeedEnabled()) return;

    const make = (
      courseId: number,
      instructorId: number,
      date: string,
      start: string,
      minutes: number,
      status: ClassSession['status'],
    ): Promise<number> => this.sessionsStore.insert({
        courseId, instructorId, sessionDate: date, startTime: start,
        endTime: minToHhmm(hhmmToMin(start) + minutes), durationMinutes: minutes, status,
        topic: '정규 수업', // 캘린더 표기는 실데이터 문구만(피드백 2026-07-02)
      } as Omit<SessionWithPayout, 'id' | 'createdAt' | 'updatedAt'>).then((row) => row.id);
    // 세션 + 보고서(작성→승인) 동시 생성. status==='held'·승인이라야 시수 적격.
    const withApprovedReport = async (sessionId: number, studentId: number) => {
      const existing = this.reports.findBySession(sessionId).find((r) => r.studentId === studentId);
      const r = existing ?? await this.reports.create({ sessionId, studentId, content: '진도·피드백(데모)' });
      if (r.approvalStatus === 'approved') return;
      const submitted = r.approvalStatus === 'submitted' ? r : await this.reports.submit(r.id);
      await this.reports.approve(submitted.id, 0);
    };

    // 강사1(박지훈) — 적격 3건(미정산)
    await withApprovedReport(await make(10, 1, '2026-06-08', '16:00', 90, 'held'), 1);
    await withApprovedReport(await make(10, 1, '2026-06-10', '16:00', 90, 'held'), 1);
    await withApprovedReport(await make(12, 1, '2026-06-15', '18:00', 120, 'held'), 1);
    // 게이트 데모: held이지만 보고서 없음 → 제외
    await make(10, 1, '2026-06-09', '16:00', 60, 'held');
    // 게이트 데모: 보고서 승인됐지만 취소 → 제외
    await withApprovedReport(await make(10, 1, '2026-06-11', '16:00', 90, 'canceled'), 1);

    // 강사2(정유진) — 적격 3건 → 즉시 정산·지급(완료 상태 시연)
    await withApprovedReport(await make(11, 2, '2026-06-09', '16:00', 120, 'held'), 2);
    await withApprovedReport(await make(11, 2, '2026-06-11', '16:00', 120, 'held'), 2);
    await withApprovedReport(await make(11, 2, '2026-06-16', '16:00', 120, 'held'), 2);
    const paid = await this.generate(2, '2026-06-01', '2026-06-30');
    await this.confirm(paid.id);
    await this.pay(paid.id);
  }

  private round(n: number): number {
    return Math.round(n);
  }

  // 시수 측정(순수 계산) — preview/generate 공통.
  measure(instructorId: number, from: string, to: string): MeasureResult {
    if (!from || !to) throw new BadRequestException('정산 기간(from/to)이 필요합니다');
    if (from > to) throw new BadRequestException('정산 기간이 잘못되었습니다(from > to)');

    const approved = this.reports.approvedSessionIds();
    const sessions = this.db.findBy<SessionWithPayout>(
      SESSIONS,
      (s) =>
        s.instructorId === instructorId &&
        s.sessionDate >= from &&
        s.sessionDate <= to &&
        countsForTeachingHours(s) && // (1, 1-b) 진행 완료 + 강사 결석 제외(공통 정책)
        approved.has(s.id) && // (2) 승인 보고서 존재
        s.payoutId == null, // (4) 미연결(이중 계상 방지)
    );

    const lines: PayoutLine[] = [];
    for (const s of sessions) {
      const course = this.db.findById<Course>(COURSES, s.courseId);
      // (3) 코스 FK 무결성 — 시급 조인 불가면 산정 중단(데이터 오류를 조용히 넘기지 않음)
      if (!course) throw new BadRequestException(`courseId ${s.courseId} 없음 — 시급 조인 실패(세션 ${s.id})`);
      const amount = payoutAmountOf(s.durationMinutes, course.hourlyRate); // [C4] 환산식 단일 소스(policy)
      lines.push({
        sessionId: s.id,
        courseId: s.courseId,
        courseName: course.name,
        sessionDate: s.sessionDate,
        durationMinutes: s.durationMinutes,
        hourlyRate: course.hourlyRate,
        amount,
      });
    }
    lines.sort((a, b) => a.sessionDate.localeCompare(b.sessionDate));

    const totalMinutes = lines.reduce((acc, l) => acc + l.durationMinutes, 0);
    const computedAmount = lines.reduce((acc, l) => acc + l.amount, 0);
    return {
      instructorId,
      periodStart: from,
      periodEnd: to,
      sessionCount: lines.length,
      totalMinutes,
      computedAmount,
      lines,
    };
  }

  // 미리보기(읽기 전용) — 정산서 생성 없이 산정 결과만.
  preview(instructorId: number, from: string, to: string): MeasureResult {
    return this.measure(instructorId, from, to);
  }

  // 정산서 생성(pending) + 세션 연결(payoutId·페이 스냅샷 기록 → 이중 계상 방지).
  async generate(instructorId: number, from: string, to: string): Promise<InstructorPayoutRow> {
    // [원자성] 정산서 생성 + 세션 payoutId 연결이 함께 성공/실패(이중계상 방지 불변식 보호)
    return this.unitOfWork.run(async () => {
      const m = this.measure(instructorId, from, to);
      if (m.sessionCount === 0)
        throw new BadRequestException('정산 대상 세션이 없습니다(진행 완료 + 승인 보고서 필요)');

      const payout = await this.store.insert<InstructorPayoutRow>(INSTRUCTOR_PAYOUTS_SPEC, {
        instructorId,
        periodStart: from,
        periodEnd: to,
        sessionCount: m.sessionCount,
        totalMinutes: m.totalMinutes,
        computedAmount: m.computedAmount,
        amount: m.computedAmount,
        status: 'pending',
        lines: m.lines,
      });

      // 세션 ← 정산서 연결(FK). 이후 measure에서 payoutId!=null 로 제외됨.
      for (const l of m.lines) {
        const claimed = await this.sessionsStore.claimPayout(l.sessionId, payout.id, l.amount);
        if (!claimed)
          throw new ConflictException(`세션 ${l.sessionId}이 다른 정산서에 먼저 연결되었습니다. 다시 산정해 주세요.`);
      }
      return payout;
    });
  }

  findAll(): InstructorPayoutRow[] {
    return this.db.findAll<InstructorPayoutRow>(PAYOUTS);
  }

  findByInstructor(instructorId: number): InstructorPayoutRow[] {
    return this.db
      .findByField<InstructorPayoutRow>(PAYOUTS, 'instructorId', instructorId)
      .sort((a, b) => (b.periodStart + b.createdAt).localeCompare(a.periodStart + a.createdAt));
  }

  findOne(id: number): InstructorPayoutRow {
    const row = this.db.findById<InstructorPayoutRow>(PAYOUTS, id);
    if (!row) throw new NotFoundException(`Payout ${id} not found`);
    return row;
  }

  // 대표 확정(pending → confirmed)
  async confirm(id: number): Promise<InstructorPayoutRow> {
    const p = this.findOne(id);
    if (p.status !== 'pending') throw new BadRequestException(`확정 불가 상태(${p.status})`);
    const updated = await this.store.updateIf<InstructorPayoutRow>(INSTRUCTOR_PAYOUTS_SPEC, id, { status: 'pending' }, {
      status: 'confirmed',
      confirmedAt: new Date().toISOString(),
    });
    if (!updated) throw new ConflictException('정산 상태가 다른 요청에서 먼저 변경되었습니다');
    return updated;
  }

  // 대표 급여 수정(pending/confirmed) — 자동 산정액은 보존, 실효 지급액만 덮어씀.
  async adjust(id: number, amount: number, reason?: string): Promise<InstructorPayoutRow> {
    const p = this.findOne(id);
    if (p.status === 'paid' || p.status === 'rejected')
      throw new BadRequestException(`수정 불가 상태(${p.status})`);
    if (amount == null || amount < 0) throw new BadRequestException('수정 금액은 0 이상이어야 합니다');
    const updated = await this.store.updateIf<InstructorPayoutRow>(INSTRUCTOR_PAYOUTS_SPEC, id, { status: p.status }, {
      adjustedAmount: amount,
      adjustReason: reason,
      amount,
    });
    if (!updated) throw new ConflictException('정산 상태가 다른 요청에서 먼저 변경되었습니다');
    return updated;
  }

  // 대표 반려(→ rejected) + 연결 세션 회수(payoutId 해제 → 재산정 가능).
  async reject(id: number, reason?: string): Promise<InstructorPayoutRow> {
    // [원자성] 반려 상태 + 연결 세션 전량 회수(부분 회수 잔존 금지)
    return this.unitOfWork.run(async () => {
      const p = this.findOne(id);
      if (p.status === 'paid') throw new BadRequestException('이미 지급됨 — 반려 불가');
      const rejected = await this.store.updateIf<InstructorPayoutRow>(INSTRUCTOR_PAYOUTS_SPEC, id, { status: p.status }, {
        status: 'rejected',
        rejectedReason: reason ?? '사유 미기재',
      });
      if (!rejected) throw new ConflictException('정산 상태가 다른 요청에서 먼저 변경되었습니다');
      for (const l of p.lines) {
        const s = this.db.findById<SessionWithPayout>(SESSIONS, l.sessionId);
        if (s && s.payoutId === id) {
          await this.sessionsStore.update(l.sessionId, {
            payoutId: null,
            instructorPayAmount: null,
          } as never);
        }
      }
      return rejected;
    });
  }

  // 지급 완료(confirmed → paid) + 통합 원장 출금 1줄 기록.
  async pay(id: number): Promise<{ payout: InstructorPayoutRow; transaction: TransactionRow }> {
    // [원자성] 지급 상태 + 통합 원장 출금 1줄이 함께 기록(원장 누락/유령 지급 방지)
    return this.unitOfWork.run(async () => {
      const p = this.findOne(id);
      if (p.status === 'paid') throw new ConflictException('이미 지급된 정산입니다');
      if (p.status !== 'confirmed') throw new BadRequestException(`지급 불가 상태(${p.status}) — confirmed만 지급 가능`);
      const now = new Date().toISOString();
      const payout = await this.store.updateIf<InstructorPayoutRow>(INSTRUCTOR_PAYOUTS_SPEC, id, { status: 'confirmed' }, {
        status: 'paid',
        paidAt: now,
      });
      if (!payout) throw new ConflictException('정산 상태가 다른 요청에서 먼저 변경되었습니다');
      const transaction = await this.store.insert<TransactionRow>(TRANSACTIONS_SPEC, {
        direction: 'out',
        category: 'instructor_payout',
        label: `강사 ${p.instructorId} 페이(${p.periodStart}~${p.periodEnd})`,
        amount: payout.amount,
        occurredAt: now,
        payoutId: id,
      });
      return { payout, transaction };
    });
  }
}
