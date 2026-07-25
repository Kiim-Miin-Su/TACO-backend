import { BadRequestException, ConflictException, ForbiddenException, Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common';
import { sessionEndPassed } from '../schedule/session-time.policy'; // [TBO-66 T2]
import { todayKst } from '../../common/time.util'; // [TBO-65 M2]
import { InMemoryDatabase } from '../../database/in-memory.database';
import { ATTENDANCE_SPEC, COURSES_SPEC, ENROLLMENTS_SPEC, INSTRUCTOR_PAYOUTS_SPEC, SESSION_REPORTS_SPEC, STUDENTS_SPEC, TRANSACTIONS_SPEC, USERS_SPEC } from '../../database/calendar-asset-specs';
import { PostgresCollectionStore } from '../../database/postgres-collection.store';
import { ClassSession, SESSIONS } from '../schedule/schedule.entity';

import { ClassSessionsStore } from '../schedule/class-sessions.store';
import { buildCohortIndex, participantIdsForSession } from '../schedule/session-participant.policy';
import { classifySessionForPayout } from './payout-worksheet.policy'; // [TBO-64] 가격 분류 단일 진실원
import { Enrollment, ENROLLMENTS } from '../enrollments/enrollment.entity';
import { Attendance, ATTENDANCE } from '../attendance/attendance.entity';
import { Student, STUDENTS } from '../students/student.entity';
import type { PayoutWorksheet, PayoutWorksheetRow } from './payout-worksheet.policy';
import { SessionReportRow, SESSION_REPORTS } from '../reports/report.entity';
import { CalendarUnitOfWork } from '../../database/calendar-unit-of-work.service';
import { CoursesService } from '../courses/courses.service';
import { USERS, isActiveInstructor, type StaffAccount } from '../users/user.entity'; // 대표 schedule owner는 정산 제외
import { AuditService } from '../audit/audit.service';
import { PayoutReadinessService } from './payout-readiness.service';
import {
  InstructorPayoutRow,
  PayoutLine,
  PAYOUTS,
  TransactionRow,
} from './payout.entity';

// 세션 행은 정산 연결 후 payoutId/페이 스냅샷을 갖는다(ERD class_sessions).
type SessionWithPayout = ClassSession & {
  payoutId?: number; instructorPayAmount?: number;
  // [TBO-32 C1 2026-07-20] 지급 이력·무결성 — is_paid(지급 완료 플래그·회수 시에만 false 복귀),
  //  paid_payout_id(마지막 지급 정산서 — 회수로 payoutId가 끊겨도 이력 잔존).
  isPaid?: boolean; paidPayoutId?: number | null;
};

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
 *   2) 대상 학생 전원의 보고서 승인 → 모든 reports.approvalStatus === 'approved'
 *   3) 코스 FK 유효(시급 조인)    → courses.id 존재
 *   4) 다른 정산서에 미연결        → session.payoutId == null (이중 계상 방지)
 * 페이 = Σ round(durationMinutes / 60 × effectiveCourseHourlyRate)
 *
 * ⚠ [TBO-19 시수 정책 · 2026-07-07 — 잠정 비즈니스 로직, 추후 변경]
 *   강사 결석·수업 미진행(취소/노쇼)·보강(makeup)은 우선 **시수 제외**(대표 결정). 지각은 인정(감산 없음).
 *   변경 시 FE `lib/domain/schedule.countsForPay`와 **동시** 수정(단일 규칙). 정책 문서=docs/TODO.md TBO-19.
 */
@Injectable()
export class PayoutsService implements OnModuleInit {
  // [TBO-58 P2] 도메인 command 1줄 로그 — payments [money] 패턴 확장(allowlist: id·상태·금액만)
  private readonly moneyLog = new Logger('money');

  constructor(
    private readonly db: InMemoryDatabase,
    private readonly store: PostgresCollectionStore,
    private readonly sessionsStore: ClassSessionsStore,
    private readonly unitOfWork: CalendarUnitOfWork,
    private readonly audit: AuditService, // [감사 전수 2026-07-16] 급여 전 상태전환 이력(대표 지시)
    private readonly courses: CoursesService,
    private readonly readiness: PayoutReadinessService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.store.hydrate<InstructorPayoutRow>(INSTRUCTOR_PAYOUTS_SPEC);
  }

  // 시수 측정(순수 계산) — preview/generate 공통.
  measure(instructorId: number, from: string, to: string): MeasureResult {
    if (!isActiveInstructor(this.db.findById<StaffAccount>(USERS, instructorId)))
      throw new BadRequestException('정산 대상은 활성 강사만 가능합니다.');
    if (!from || !to) throw new BadRequestException('정산 기간(from/to)이 필요합니다');
    if (from > to) throw new BadRequestException('정산 기간이 잘못되었습니다(from > to)');

    // [TBO-64 2026-07-24] 산정 = 워크시트 가격 분류(단일 진실원 — classifySessionForPayout) 소비.
    //  · auto(정상 진행+승인 리포트+단가) = 시급×시간 기본값(책정가 있으면 책정가 우선)
    //  · manual(지각·리포트 미완·roster/단가 누락) = 책정가가 있어야만 포함(빈칸은 합계·정산 제외)
    //  · excluded(결석·미진행·기연결) = 제외. 종전 "지각 자동 포함" 정책은 대표 지시 ⑤·⑧로 폐지.
    const cohortIndex = buildCohortIndex(this.db.findAll<Enrollment>(ENROLLMENTS));
    const reportsByKey = new Map(
      this.db.findAll<SessionReportRow>(SESSION_REPORTS).map((r) => [`${r.sessionId}:${r.studentId}`, r]),
    );
    // [기간설정 지시 ① 2026-07-24] 출결 현황도 분류 입력 — 미기록이면 auto 금지(직접 입력)
    const attendanceByKey = new Map(
      this.db.findAll<Attendance>(ATTENDANCE).map((a) => [`${a.sessionId}:${a.studentId}`, a.status]),
    );
    const sessions = this.db.findBy<SessionWithPayout>(
      SESSIONS,
      (s) => s.instructorId === instructorId && s.sessionDate >= from && s.sessionDate <= to,
    );

    const lines: PayoutLine[] = [];
    for (const s of sessions) {
      const course = this.courses.findOptional(s.courseId);
      const participantIds = participantIdsForSession(s, cohortIndex);
      const classification = classifySessionForPayout(s, {
        participantIds,
        reportOf: (studentId) => reportsByKey.get(`${s.id}:${studentId}`),
        attendanceOf: (studentId) => attendanceByKey.get(`${s.id}:${studentId}`),
        hourlyRate: course?.hourlyRate,
      });
      if (classification.effectiveAmount == null) continue; // manual 미책정·excluded — 정산 라인 제외
      lines.push({
        sessionId: s.id,
        courseId: s.courseId,
        courseName: course?.name ?? `코스 ${s.courseId}`,
        sessionDate: s.sessionDate,
        durationMinutes: s.durationMinutes,
        hourlyRate: course?.hourlyRate ?? 0,
        amount: classification.effectiveAmount,
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
  // [리뷰 P0-4 2026-07-20] 잠금 후 재하이드레이트 — 멀티 인스턴스(serverless)에서 스테일 메모리로
  //  적격성(취소·보고서 반려를 못 본 계상)·상태 전이를 판정하지 않도록, payout 경로도 schedule의
  //  lock→refreshAfterLock 규약에 편입한다. 세션·보고서·정산서 세 자산이 판정 입력의 전부다.
  private async refreshAfterLock(): Promise<void> {
    await this.sessionsStore.ensureReady();
    await this.store.hydrate(SESSION_REPORTS_SPEC); // 보고서(승인 상태) — 적격 판정 입력
    await this.store.hydrate<InstructorPayoutRow>(INSTRUCTOR_PAYOUTS_SPEC);
    // [TBO-56 C2b] 적격(활성 강사)·코호트·단가 판정 입력도 DB 기준 — TBO-55 감사 갭 해소.
    await this.store.hydrate(USERS_SPEC);
    await this.store.hydrate(ENROLLMENTS_SPEC);
    await this.store.hydrate(COURSES_SPEC);
    // [TBO-64] 워크시트 입력(참가자 출결·학생명)도 DB 기준.
    await this.store.hydrate(ATTENDANCE_SPEC);
    await this.store.hydrate(STUDENTS_SPEC);
  }

  /** [TBO-56 C2b] 읽기 전용 산정(preview/readiness/uncovered)도 요청마다 입력 표 재수화 —
   *  교차 인스턴스의 세션·보고서·정산 변경이 즉시 산정에 반영된다(순수 정책 함수는 무변). */
  private async refreshReadInputs(): Promise<void> {
    await this.refreshAfterLock();
  }

  async measureFresh(instructorId: number, from: string, to: string): Promise<MeasureResult> {
    await this.refreshReadInputs();
    return this.measure(instructorId, from, to);
  }

  async uncoveredFresh(months = 3): Promise<ReturnType<PayoutsService['uncovered']>> {
    await this.refreshReadInputs();
    return this.uncovered(months);
  }

  /** [TBO-56 C2b] 목록/단건 READ = DB 권위(findActive). */
  listDb(): Promise<InstructorPayoutRow[]> {
    return this.store.findActive<InstructorPayoutRow>(INSTRUCTOR_PAYOUTS_SPEC, { orderBy: { field: 'id' } });
  }

  async listByInstructorDb(instructorId: number, opts?: { paidOnly?: boolean }): Promise<InstructorPayoutRow[]> {
    const rows = await this.store.findActive<InstructorPayoutRow>(INSTRUCTOR_PAYOUTS_SPEC, {
      where: { instructorId } as Partial<InstructorPayoutRow>,
    });
    // [TBO-62 ⑥ 2026-07-24] 강사 표면 = 지급 완료(paid)만 — 산정·확정 등 지급 전 상태는 관리자 전용.
    const visible = opts?.paidOnly ? rows.filter((row) => row.status === 'paid') : rows;
    return visible.sort((a, b) => (b.periodStart + b.createdAt).localeCompare(a.periodStart + a.createdAt));
  }

  private async payoutFromDb(id: number): Promise<InstructorPayoutRow> {
    const [row] = await this.store.findActive<InstructorPayoutRow>(INSTRUCTOR_PAYOUTS_SPEC, {
      where: { id } as Partial<InstructorPayoutRow>, limit: 1,
    });
    if (!row) throw new NotFoundException(`Payout ${id} not found`);
    return row;
  }

  /** [TBO-64 2026-07-24] 시수 워크시트 — 강사·기간의 전 회차를 가격 분류와 함께(매니저/대표 화면).
   *  measure와 같은 분류 함수를 공유(단일 진실원)하되, 표시용으로 excluded 회차까지 전부 담는다. */
  async worksheetFresh(instructorId: number, from: string, to: string): Promise<PayoutWorksheet> {
    await this.refreshReadInputs();
    if (!isActiveInstructor(this.db.findById<StaffAccount>(USERS, instructorId)))
      throw new BadRequestException('활성 강사만 조회할 수 있습니다.');
    if (!from || !to) throw new BadRequestException('기간(from/to)이 필요합니다');
    if (from > to) throw new BadRequestException('기간이 잘못되었습니다(from > to)');

    const cohortIndex = buildCohortIndex(this.db.findAll<Enrollment>(ENROLLMENTS));
    const reportsByKey = new Map(
      this.db.findAll<SessionReportRow>(SESSION_REPORTS).map((r) => [`${r.sessionId}:${r.studentId}`, r]),
    );
    const attendanceByKey = new Map(
      this.db.findAll<Attendance>(ATTENDANCE).map((a) => [`${a.sessionId}:${a.studentId}`, a.status]),
    );
    const studentNameOf = (id: number) => this.db.findById<Student>(STUDENTS, id)?.name ?? `학생 ${id}`;

    const sessions = this.db
      .findBy<SessionWithPayout>(SESSIONS, (x) => x.instructorId === instructorId && x.sessionDate >= from && x.sessionDate <= to)
      .sort((a, b) => `${a.sessionDate}:${a.startTime}:${a.id}`.localeCompare(`${b.sessionDate}:${b.startTime}:${b.id}`));

    const rows: PayoutWorksheetRow[] = sessions.map((session) => {
      const course = this.courses.findOptional(session.courseId);
      const participantIds = participantIdsForSession(session, cohortIndex);
      const classification = classifySessionForPayout(session, {
        participantIds,
        reportOf: (studentId) => reportsByKey.get(`${session.id}:${studentId}`),
        attendanceOf: (studentId) => attendanceByKey.get(`${session.id}:${studentId}`), // [기간설정 ①]
        hourlyRate: course?.hourlyRate,
      });
      return {
        sessionId: session.id,
        sessionDate: session.sessionDate,
        startTime: session.startTime ?? null,
        durationMinutes: session.durationMinutes,
        courseId: session.courseId,
        courseName: course?.name ?? `코스 ${session.courseId}`,
        hourlyRate: course?.hourlyRate ?? null,
        status: session.status,
        instructorAttendance: session.instructorAttendance ?? null,
        payoutId: session.payoutId ?? null,
        participants: participantIds.map((studentId) => {
          const report = reportsByKey.get(`${session.id}:${studentId}`);
          return {
            studentId,
            name: studentNameOf(studentId),
            attendance: attendanceByKey.get(`${session.id}:${studentId}`) ?? null,
            reportApproval: report ? report.approvalStatus ?? 'draft' : null, // null = 미작성
          };
        }),
        pricing: classification,
      };
    });

    const included = rows.filter((row) => row.pricing.effectiveAmount != null);
    const totals = {
      sessionCount: rows.length,
      includedCount: included.length,
      totalMinutes: included.reduce((acc, row) => acc + row.durationMinutes, 0),
      autoAmount: included.filter((r) => r.pricing.kind === 'auto').reduce((acc, r) => acc + (r.pricing.effectiveAmount ?? 0), 0),
      manualAmount: included.filter((r) => r.pricing.kind === 'manual').reduce((acc, r) => acc + (r.pricing.effectiveAmount ?? 0), 0),
      totalAmount: included.reduce((acc, r) => acc + (r.pricing.effectiveAmount ?? 0), 0),
      unpricedCount: rows.filter((r) => r.pricing.kind === 'manual' && r.pricing.effectiveAmount == null).length,
      excludedCount: rows.filter((r) => r.pricing.kind === 'excluded').length,
    };
    return { instructorId, periodStart: from, periodEnd: to, rows, totals };
  }

  async getScopedDb(id: number, roles: string[], _actorId?: number): Promise<InstructorPayoutRow> {
    const row = await this.payoutFromDb(id);
    const isPrivileged = roles.includes('super_admin');
    // [기간설정 지시 ② 2026-07-24] 강사는 **단건 상세(회차별 산정 lines) 전면 불가** — 지급 완료
    //  요약(기간·시수·금액·지급일)은 목록(GET /payouts/me)으로 충분(대표: "이미 지급된 것만,
    //  상세내역은 불가"). 종전 paid 단건 200(TBO-62 ⑥)에서 한 단계 더 좁힘 — 정책 변화 명시.
    if (!isPrivileged) {
      throw new ForbiddenException('정산 상세 내역은 관리자 전용입니다. 지급 내역은 내 페이 목록에서 확인하세요.');
    }
    return row;
  }

  async generate(instructorId: number, from: string, to: string, actorId?: number): Promise<InstructorPayoutRow> {
    // [원자성] 정산서 생성 + 세션 payoutId 연결이 함께 성공/실패(이중계상 방지 불변식 보호)
    return this.unitOfWork.run(async () => {
      // [리뷰 P0-4] 강사 단위 직렬화 + 잠금 후 재하이드레이트 — 스테일 메모리 계상 차단.
      await this.unitOfWork.lockTargets([{ kind: 'instructor', id: instructorId }]);
      await this.refreshAfterLock();
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

      // [TBO-58 P2 치명 갭 ②] 진행 로그 — 부분 실패 시 "어디까지 갔는지" 로그만으로 재구성.
      this.moneyLog.log(`action=generate payout=${payout.id} instructor=${instructorId} period=${from}..${to} sessions=${m.lines.length} amount=${payout.amount} result=begin`);
      // 세션 ← 정산서 연결(FK). 이후 measure에서 payoutId!=null 로 제외됨.
      for (const l of m.lines) {
        const claimed = await this.sessionsStore.claimPayout(l.sessionId, payout.id, l.amount);
        if (!claimed) {
          this.moneyLog.warn(`action=generate.claim payout=${payout.id} session=${l.sessionId} result=conflict(rollback)`);
          throw new ConflictException(`세션 ${l.sessionId}이 다른 정산서에 먼저 연결되었습니다. 다시 산정해 주세요.`);
        }
        this.moneyLog.log(`action=generate.claim payout=${payout.id} session=${l.sessionId} amount=${l.amount ?? 0} result=linked`);
      }
      // [감사 전수 2026-07-16] 정산서 생성 + 세션 payout 연결(⚠ class_sessions 누락 경로) 이력.
      if (actorId != null) {
        await this.audit.log({
          entity: 'instructor_payouts', entityId: payout.id, action: 'create', actorId,
          changes: { amount: { after: payout.amount }, sessionIds: { after: m.lines.map((l) => l.sessionId) } },
        });
      }
      this.moneyLog.log(`action=generate payout=${payout.id} instructor=${instructorId} sessions=${m.lines.length} amount=${payout.amount} result=created`);
      return payout;
    });
  }

  // ── [TBO-32 C1 2026-07-20] 일괄 산정 + 미정산 감지 ─────────────────────────

  /** 활성 강사 id 목록(일괄 산정 기본 대상). */
  private activeInstructorIds(): number[] {
    return this.db
      .findBy<StaffAccount>(USERS, (a) => a.role === 'instructor' && a.status === 'active')
      .map((a) => a.id);
  }

  /**
   * 일괄 산정 — 강사별 **독립 tx**(generate 재사용: 한 강사의 실패가 다른 강사의 생성을 막지 않는다).
   * 적격 0은 skipped(정상), 그 외 예외는 failed(요약 보고 — 조용한 누락 금지). 이중 계상은
   * generate 내부의 payoutId CAS 선점(claimPayout)이 그대로 방어한다.
   */
  async generateBulk(
    periodStart: string,
    periodEnd: string,
    instructorIds: number[] | undefined,
    actorId?: number,
  ): Promise<{
    generated: Array<{ instructorId: number; payoutId: number; amount: number; sessionCount: number }>;
    skipped: Array<{ instructorId: number; reason: string }>;
    failed: Array<{ instructorId: number; error: string }>;
  }> {
    const targets = instructorIds?.length ? instructorIds : this.activeInstructorIds();
    const generated: Array<{ instructorId: number; payoutId: number; amount: number; sessionCount: number }> = [];
    const skipped: Array<{ instructorId: number; reason: string }> = [];
    const failed: Array<{ instructorId: number; error: string }> = [];
    for (const instructorId of targets) {
      try {
        const payout = await this.generate(instructorId, periodStart, periodEnd, actorId);
        generated.push({ instructorId, payoutId: payout.id, amount: payout.amount, sessionCount: payout.sessionCount });
      } catch (caught) {
        const message = caught instanceof Error ? caught.message : String(caught);
        if (caught instanceof BadRequestException && message.includes('정산 대상 세션이 없습니다')) {
          skipped.push({ instructorId, reason: 'no_eligible_sessions' });
        } else {
          this.moneyLog.warn(`action=generateBulk.item instructor=${instructorId} result=failed`); // [TBO-58 P2] 실패도 1줄(조용한 누락 금지)
          failed.push({ instructorId, error: message });
        }
      }
    }
    // [TBO-58 P2] 일괄 산정 요약 — 몇 명 중 몇 명 생성/스킵/실패인지 로그만으로 재구성
    this.moneyLog.log(`action=generateBulk actor=${actorId ?? 0} period=${periodStart}..${periodEnd} targets=${targets.length} generated=${generated.length} skipped=${skipped.length} failed=${failed.length}`);
    return { generated, skipped, failed };
  }

  /**
   * 미정산 감지 — 최근 N개월(당월 포함) 중 "적격 세션이 있는데 정산서에 미연결"인 (강사×월) 목록.
   * measure()와 같은 규칙(진행 완료+승인 보고서+미연결+미지급)이라 여기 잡힌 것은 곧 일괄 산정
   * 대상이다. 읽기 전용 — 정산서 존재 여부와 무관하게 잔여 적격만 본다(부분 산정 월도 잡힘).
   */
  uncovered(months = 3): Array<{
    instructorId: number; instructorName: string; instructorStatus: string; month: string;
    periodStart: string; periodEnd: string; sessionCount: number; totalMinutes: number; computedAmount: number;
    executionMissingCount: number; // [TBO-66 T2] 기간 내 종료 경과 scheduled(실행 미확정 — 조용한 누락 방지)
  }> {
    const boundedMonths = Math.min(Math.max(Math.trunc(months) || 3, 1), 12);
    // [리뷰 P1-2 2026-07-22] 비활성(퇴직 등) 강사의 미지급분도 감지 — 조용한 소실 방지.
    //  pending/rejected 강사는 수업이 없어 measure 0으로 자연 배제되고, active 외 상태는
    //  instructorStatus로 표시해 화면에서 구분한다(일괄 산정 기본 대상은 여전히 active만).
    const instructors = this.db.findBy<StaffAccount>(USERS, (a) => a.role === 'instructor');
    // [TBO-65 M2] 월 경계 앵커 = KST 오늘(종전 UTC now — KST 1일 00~09시에 전월로 잡히던 어긋남)
    const [anchorYear, anchorMonth] = todayKst().split('-').map(Number);
    const nowMs = Date.now();
    const entries: Array<{
      instructorId: number; instructorName: string; instructorStatus: string; month: string;
      periodStart: string; periodEnd: string; sessionCount: number; totalMinutes: number; computedAmount: number;
      executionMissingCount: number;
    }> = [];
    for (let back = 0; back < boundedMonths; back += 1) {
      const first = new Date(Date.UTC(anchorYear, anchorMonth - 1 - back, 1));
      const last = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0));
      const periodStart = first.toISOString().slice(0, 10);
      const periodEnd = last.toISOString().slice(0, 10);
      for (const instructor of instructors) {
        const m = this.measure(instructor.id, periodStart, periodEnd);
        // [TBO-66 T2 2026-07-25] 실행 미확정(종료 경과 scheduled·미연결)도 계상 — 종전엔 적격만 세어
        //  "출결·리포트를 아무도 안 찍은 달"이 대표 배너에서 완전히 보이지 않았다(readiness와 비대칭).
        const executionMissingCount = this.db.findBy<SessionWithPayout>(
          SESSIONS,
          (x) => x.instructorId === instructor.id && x.sessionDate >= periodStart && x.sessionDate <= periodEnd
            && x.status === 'scheduled' && x.payoutId == null && sessionEndPassed(x, nowMs),
        ).length;
        if (m.sessionCount === 0 && executionMissingCount === 0) continue;
        entries.push({
          instructorId: instructor.id,
          instructorName: instructor.name,
          instructorStatus: instructor.status, // [P1-2] active 외 상태(퇴직 등) 화면 구분용
          month: periodStart.slice(0, 7),
          periodStart,
          periodEnd,
          sessionCount: m.sessionCount,
          totalMinutes: m.totalMinutes,
          computedAmount: m.computedAmount,
          executionMissingCount,
        });
      }
    }
    return entries.sort((a, b) => a.month.localeCompare(b.month) || a.instructorId - b.instructorId);
  }

  findAll(): InstructorPayoutRow[] {
    return this.db.findAll<InstructorPayoutRow>(PAYOUTS);
  }

  findByInstructor(instructorId: number): InstructorPayoutRow[] {
    return this.db
      .findByField<InstructorPayoutRow>(PAYOUTS, 'instructorId', instructorId)
      .sort((a, b) => (b.periodStart + b.createdAt).localeCompare(a.periodStart + a.createdAt));
  }

  // [TBO-32 C4 2026-07-22] 단건 스코프 조회 — 강사는 본인 정산만(타인 403 — B7 reports IDOR 수정과
  //  동일 규약: 404 은닉이 아니라 403 명시. 존재 자체는 강사 자기 목록으로 이미 알 수 있는 정보).
  findOneScoped(id: number, roles: string[], actorId?: number): InstructorPayoutRow {
    const row = this.findOne(id);
    const isPrivileged = roles.includes('super_admin');
    if (!isPrivileged && row.instructorId !== actorId) {
      throw new ForbiddenException('본인 정산서만 조회할 수 있습니다.');
    }
    return row;
  }

  findOne(id: number): InstructorPayoutRow {
    const row = this.db.findById<InstructorPayoutRow>(PAYOUTS, id);
    if (!row) throw new NotFoundException(`Payout ${id} not found`);
    return row;
  }

  // 대표 확정(pending → confirmed)
  async confirm(id: number, actorId?: number): Promise<InstructorPayoutRow> {
    // [감사 전수 2026-07-16] 상태전환 + 이력 원자화(uow — 이력 실패 시 전환도 롤백).
    return this.unitOfWork.run(async () => {
      const p = this.findOne(id);
      if (p.status !== 'pending') throw new BadRequestException(`확정 불가 상태(${p.status})`);
      const updated = await this.store.updateIf<InstructorPayoutRow>(INSTRUCTOR_PAYOUTS_SPEC, id, { status: 'pending' }, {
        status: 'confirmed',
        confirmedAt: new Date().toISOString(),
      });
      if (!updated) throw new ConflictException('정산 상태가 다른 요청에서 먼저 변경되었습니다');
      if (actorId != null) {
        await this.audit.log({
          entity: 'instructor_payouts', entityId: id, action: 'approve', actorId,
          changes: { status: { before: 'pending', after: 'confirmed' } },
        });
      }
      this.moneyLog.log(`action=confirm payout=${id} actor=${actorId ?? 0} amount=${updated.amount} result=confirmed`); // [TBO-58 P2]
      return updated;
    });
  }

  // 대표 급여 수정(pending/confirmed) — 자동 산정액은 보존, 실효 지급액만 덮어씀.
  // [TBO-32 C2 2026-07-22 D2] 확정 취소(confirmed→pending) — 지급 전 "확정 실수"의 출구.
  //  종전엔 반려(세션 회수→재산정)뿐이라 확정만 되돌릴 수 없었다. 상태 그래프 완결:
  //  pending⇄confirmed→paid⇄(reverse). 사유 필수·audit·CAS(동시 지급/취소 한쪽만)·잠금+재하이드레이트.
  async unconfirm(id: number, reason: string, actorId?: number): Promise<InstructorPayoutRow> {
    return this.unitOfWork.run(async () => {
      await this.unitOfWork.lockTargets([{ kind: 'payout', id }]);
      await this.refreshAfterLock();
      const p = this.findOne(id);
      if (p.status !== 'confirmed')
        throw new BadRequestException(`확정 취소 불가 상태(${p.status}) — confirmed만 취소할 수 있습니다. 지급 후에는 회수(reverse)를 사용하세요.`);
      const updated = await this.store.updateIf<InstructorPayoutRow>(INSTRUCTOR_PAYOUTS_SPEC, id, { status: 'confirmed' }, {
        status: 'pending',
        confirmedAt: null as never, // 확정 메타 원복(재확정 시 새로 스탬프)
      });
      if (!updated) throw new ConflictException('정산 상태가 다른 요청에서 먼저 변경되었습니다');
      if (actorId != null) {
        await this.audit.log({
          entity: 'instructor_payouts', entityId: id, action: 'status_change', actorId,
          changes: { status: { before: 'confirmed', after: 'pending' } },
          reason,
        });
      }
      this.moneyLog.log(`action=unconfirm payout=${id} actor=${actorId ?? 0} result=pending`); // [TBO-58 P2]
      return updated;
    });
  }

  async adjust(id: number, amount: number, reason?: string, actorId?: number): Promise<InstructorPayoutRow> {
    return this.unitOfWork.run(async () => {
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
      // [감사 전수 2026-07-16] 금액 수정은 감사 필수 — 산정액/실효액 diff + 사유.
      if (actorId != null) {
        await this.audit.log({
          entity: 'instructor_payouts', entityId: id, action: 'update', actorId,
          changes: { amount: { before: p.amount, after: amount } }, reason,
        });
      }
      return updated;
    });
  }

  // 대표 반려(→ rejected) + 연결 세션 회수(payoutId 해제 → 재산정 가능).
  async reject(id: number, reason?: string, actorId?: number): Promise<InstructorPayoutRow> {
    // [원자성] 반려 상태 + 연결 세션 전량 회수(부분 회수 잔존 금지)
    return this.unitOfWork.run(async () => {
      // [TBO-56 C2b] 강사 단위 lock + 재수화 — 세션 회수 판정(payoutId===id)을 DB 기준으로(회수 누락 차단).
      const scoped = await this.payoutFromDb(id);
      await this.unitOfWork.lockTargets([{ kind: 'instructor', id: scoped.instructorId }]);
      await this.refreshAfterLock();
      const p = await this.payoutFromDb(id);
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
      // [감사 전수 2026-07-16] 반려 + 세션 회수(payout 해제)까지 한 이력으로.
      if (actorId != null) {
        await this.audit.log({
          entity: 'instructor_payouts', entityId: id, action: 'reject', actorId,
          changes: { status: { before: p.status, after: 'rejected' }, releasedSessionIds: { after: p.lines.map((l) => l.sessionId) } },
          reason: reason ?? '사유 미기재',
        });
      }
      return rejected;
    });
  }

  // [B9 E5 2026-07-16] 지급 회수(보상 command) — FEATURE-GAP P1 "실서비스 금전 흐름의 마지막 구멍".
  //  지급(paid) 이후 되돌리는 유일 경로. 관례(payments.refund)를 따른다: 원 행·원 거래는 수정하지
  //  않고 **반대 direction(in)의 보상 거래를 append**(원장 append-only). 상태는 rejected 재사용 +
  //  reversedAt(계약 PayoutStatus 확장 불가 — B9 문서 §1). 효과: 세션 잠금 해제 → 수업 수정/삭제의
  //  PAYOUT_REVERSAL_REQUIRED 409와 승인 보고서 반려("정산 회수 후") 400이 실제로 열린다.
  async reverse(id: number, reason: string, actorId?: number): Promise<{ payout: InstructorPayoutRow; transaction: TransactionRow }> {
    // [원자성] 상태 전환 + 보상 원장 + 세션 전량 회수 + 감사 — 한 tx(부분 회수 잔존 금지)
    return this.unitOfWork.run(async () => {
      // [리뷰 P0-4] 정산서 단위 직렬화 + 잠금 후 재하이드레이트(스테일 상태로 전이 판정 금지).
      await this.unitOfWork.lockTargets([{ kind: 'payout', id }]);
      await this.refreshAfterLock();
      const p = this.findOne(id);
      if (p.status !== 'paid')
        throw new BadRequestException(`회수 불가 상태(${p.status}) — 지급 완료(paid) 정산만 회수합니다. 지급 전 취소는 반려(reject)를 사용하세요.`);
      const now = new Date().toISOString();
      const payout = await this.store.updateIf<InstructorPayoutRow>(INSTRUCTOR_PAYOUTS_SPEC, id, { status: 'paid' }, {
        status: 'rejected',
        reversedAt: now,
        rejectedReason: reason, // 기존 소비처(FE 표기) 호환
        reversedReason: reason, // [TBO-32 C2 D2] 회수 사유 전용 영속(반려와 구분)
      });
      if (!payout) throw new ConflictException('정산 상태가 다른 요청에서 먼저 변경되었습니다');
      const transaction = await this.store.insert<TransactionRow>(TRANSACTIONS_SPEC, {
        direction: 'in',
        category: 'payout_reversal',
        label: `강사 ${p.instructorId} 페이 회수(${p.periodStart}~${p.periodEnd})`,
        // [리뷰 P0-5 2026-07-20] 금액 소스 = CAS 반환 행(DB 권위) — pay와 동일 규약. 종전 p.amount
        //  (CAS 이전 메모리 읽기)는 스테일 시 출금≠보상입금 원장 불일치를 만들 수 있었다.
        amount: payout.amount, // 전액 보상(부분 회수는 비범위 — B9 §3)
        occurredAt: now,
        payoutId: id,
      });
      for (const l of p.lines) {
        const s = this.db.findById<SessionWithPayout>(SESSIONS, l.sessionId);
        if (s && s.payoutId === id) {
          // [TBO-32 C1] is_paid=false 복귀(재산정 가능). paid_payout_id는 **유지** — 지급됐다가
          //  회수된 이력이 세션에 남는다(is_paid=false ∧ paid_payout_id≠NULL = 회수 이력 판별).
          await this.sessionsStore.update(l.sessionId, {
            payoutId: null,
            instructorPayAmount: null,
            isPaid: false,
          } as never);
        }
      }
      if (actorId != null) {
        await this.audit.log({
          entity: 'instructor_payouts', entityId: id, action: 'status_change', actorId,
          changes: {
            status: { before: 'paid', after: 'rejected' },
            reversedAt: { after: now },
            releasedSessionIds: { after: p.lines.map((l) => l.sessionId) },
            sessionIsPaidCleared: { after: true }, // [TBO-32 C1] 세션 지급 플래그 회수 이력
          },
          reason,
        });
        await this.audit.log({
          entity: 'transactions', entityId: transaction.id, action: 'create', actorId,
          changes: { direction: { after: 'in' }, category: { after: 'payout_reversal' }, amount: { after: transaction.amount } },
        });
      }
      this.moneyLog.log(`action=reverse payout=${id} actor=${actorId ?? 0} amount=${transaction.amount} ledgerTx=${transaction.id} releasedSessions=${p.lines.length} result=reversed`); // [TBO-58 P2]
      return { payout, transaction };
    });
  }

  // 지급 완료(confirmed → paid) + 통합 원장 출금 1줄 기록.
  async pay(id: number, actorId?: number): Promise<{ payout: InstructorPayoutRow; transaction: TransactionRow }> {
    // [원자성] 지급 상태 + 통합 원장 출금 1줄이 함께 기록(원장 누락/유령 지급 방지)
    return this.unitOfWork.run(async () => {
      // [리뷰 P0-4] 정산서 단위 직렬화 + 잠금 후 재하이드레이트.
      await this.unitOfWork.lockTargets([{ kind: 'payout', id }]);
      await this.refreshAfterLock();
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
      // [TBO-32 C1 2026-07-20] 지급 이력 플래그 — 연결 세션 전량 is_paid=true + paid_payout_id 스탬프
      //  (같은 tx — 원장·상태와 함께 성공/실패). 회수(reverse) 외에는 false로 돌아가지 않는다.
      for (const l of p.lines) {
        const sessionRow = this.db.findById<SessionWithPayout>(SESSIONS, l.sessionId);
        if (sessionRow && sessionRow.payoutId === id) {
          await this.sessionsStore.update(l.sessionId, { isPaid: true, paidPayoutId: id } as never);
        }
      }
      // [감사 전수 2026-07-16] 지급 전환 + 원장 출금 각 1건 — 대표 결정: 원장도 감사 대상.
      if (actorId != null) {
        await this.audit.log({
          entity: 'instructor_payouts', entityId: id, action: 'status_change', actorId,
          changes: { status: { before: 'confirmed', after: 'paid' }, amount: { after: payout.amount }, paidSessionIds: { after: p.lines.map((l) => l.sessionId) } }, // [TBO-32 C1] 세션 지급 플래그 이력
        });
        await this.audit.log({
          entity: 'transactions', entityId: transaction.id, action: 'create', actorId,
          changes: { direction: { after: 'out' }, category: { after: 'instructor_payout' }, amount: { after: transaction.amount } },
        });
      }
      this.moneyLog.log(`action=pay payout=${id} actor=${actorId ?? 0} amount=${transaction.amount} ledgerTx=${transaction.id} paidSessions=${p.lines.length} result=paid`); // [TBO-58 P2]
      return { payout, transaction };
    });
  }
}
