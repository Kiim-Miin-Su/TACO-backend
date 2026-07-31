// [TBO-69 C2 2026-07-26] 정산 **읽기(Read) 서비스** — payouts.service(677줄)에서 분리.
//  소유: 시수 산정(measure/preview — 분류 진실원 classifySessionForPayout 소비)·워크시트·미정산
//  감지(uncovered)·목록/단건(DB 권위 findActive)·강사 스코프 판정·판정 입력 표 재수화.
//  **본문 이동만 — 산식·정책·403 경계 무변.** 명령(payouts.service)은 이 서비스를 단방향 주입해
//  잠금 후 재조회(refreshAfterLock→refreshReadInputs)·산정(measure)·단건(findOne)을 경유한다.
import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common';
import { sessionEndPassed } from '../schedule/session-time.policy'; // [TBO-66 T2]
import { todayKst } from '../../common/time.util'; // [TBO-65 M2]
import { InMemoryDatabase } from '../../database/in-memory.database';
import { ATTENDANCE_SPEC, ENROLLMENTS_SPEC, INSTRUCTOR_PAYOUTS_SPEC, SESSION_REPORTS_SPEC, STUDENTS_SPEC, SUBJECTS_SPEC, USERS_SPEC } from '../../database/calendar-asset-specs';
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
import { CoursesService } from '../courses/courses.service';
import { USERS, isActiveInstructor, type StaffAccount } from '../users/user.entity'; // 대표 schedule owner는 정산 제외
import { InstructorPayoutRow, PayoutLine, PAYOUTS } from './payout.entity';
import { Subject, SUBJECTS } from '../subjects/subject.entity';
import { claimsHaveCapability } from '../auth/role-policy';
import type { PayoutMeasure } from '@kms545487/contracts';

// 세션 행은 정산 연결 payoutId와 사용자 책정가 override를 갖는다. 산정 스냅샷은 payout.lines가 정본이다.
type SessionWithPayout = ClassSession & {
  payoutId?: number; instructorPayAmount?: number;
  isPaid?: boolean; paidPayoutId?: number | null;
};

export type MeasureResult = PayoutMeasure;

@Injectable()
export class PayoutsReadService implements OnModuleInit {
  private readonly logger = new Logger(PayoutsReadService.name);

  constructor(
    private readonly db: InMemoryDatabase,
    private readonly store: PostgresCollectionStore,
    private readonly sessionsStore: ClassSessionsStore,
    private readonly courses: CoursesService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.store.hydrate<InstructorPayoutRow>(INSTRUCTOR_PAYOUTS_SPEC);
  }

  /** [리뷰 P0-4→TBO-69 C2] 판정 입력 표 재수화의 **단일 목록** — 명령의 잠금 후 재조회
   *  (refreshAfterLock)와 읽기 전용 산정이 같은 목록을 공유한다(사본 금지). */
  async refreshReadInputs(): Promise<void> {
    await this.sessionsStore.ensureReady();
    await this.store.hydrate(SESSION_REPORTS_SPEC); // 보고서(승인 상태) — 적격 판정 입력
    await this.store.hydrate<InstructorPayoutRow>(INSTRUCTOR_PAYOUTS_SPEC);
    // [TBO-56 C2b] 적격(활성 강사)·코호트·단가 판정 입력도 DB 기준 — TBO-55 감사 갭 해소.
    await this.store.hydrate(USERS_SPEC);
    await this.store.hydrate(ENROLLMENTS_SPEC);
    // 유효 시급은 course override + instructor profile 기본값의 projection이다.
    // CoursesService의 fresh 경계를 호출해 두 입력을 같은 read snapshot으로 갱신한다.
    await this.courses.findAllFresh();
    await this.store.hydrate(SUBJECTS_SPEC);
    // [TBO-64] 워크시트 입력(참가자 출결·학생명)도 DB 기준.
    await this.store.hydrate(ATTENDANCE_SPEC);
    await this.store.hydrate(STUDENTS_SPEC);
  }

  // 시수 측정(순수 계산) — preview/generate 공통. 활성 가드는 명령·조회 라우트의 대상 검증이다.
  measure(instructorId: number, from: string, to: string): MeasureResult {
    if (!isActiveInstructor(this.db.findById<StaffAccount>(USERS, instructorId)))
      throw new BadRequestException('정산 대상은 활성 강사만 가능합니다.');
    return this.measureCore(instructorId, from, to);
  }

  // [TBO-80 80J F-3 2026-07-31] 가드 없는 산정 코어 — uncovered 스캔 전용.
  //  uncovered는 P1-2(2026-07-22) 설계상 비활성(퇴직·반려 등) 강사의 미지급분도 감지해야 하는데,
  //  measure()의 활성 가드가 role=instructor 전체 순회 중 반려 계정에서 throw → 목록 전체가 400으로
  //  죽는 결함(시뮬레이션 QA 실측: 반려 가입 1건 후 대표 /payouts 배너 영구 실패). 주석의 "자연
  //  배제" 전제를 코드로 복원한다 — preview/generate 라우트의 활성 가드는 measure()에 그대로 유지.
  private measureCore(instructorId: number, from: string, to: string): MeasureResult {
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


  async measureFresh(instructorId: number, from: string, to: string): Promise<MeasureResult> {
    await this.refreshReadInputs();
    return this.measure(instructorId, from, to);
  }

  async uncoveredFresh(months = 3): Promise<ReturnType<PayoutsReadService['uncovered']>> {
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

  async payoutFromDb(id: number): Promise<InstructorPayoutRow> {
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
    const subjectNameOf = (id: number | undefined) =>
      id == null ? '과목 미지정' : this.db.findById<Subject>(SUBJECTS, id)?.name ?? `과목 ${id}`;

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
        subjectId: course?.subjectId ?? null,
        subjectName: subjectNameOf(course?.subjectId),
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
            reportId: report?.id ?? null,
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
    this.logger.debug(
      `action=worksheet actorScope=admin instructor=${instructorId} from=${from} to=${to} rows=${rows.length} included=${totals.includedCount} result=success`,
    );
    return { instructorId, periodStart: from, periodEnd: to, rows, totals };
  }

  async getScopedDb(id: number, roles: string[], _actorId?: number): Promise<InstructorPayoutRow> {
    const row = await this.payoutFromDb(id);
    const isPrivileged = claimsHaveCapability(roles, 'finance.access');
    // [기간설정 지시 ② 2026-07-24] 강사는 **단건 상세(회차별 산정 lines) 전면 불가** — 지급 완료
    //  요약(기간·시수·금액·지급일)은 목록(GET /payouts/me)으로 충분(대표: "이미 지급된 것만,
    //  상세내역은 불가"). 종전 paid 단건 200(TBO-62 ⑥)에서 한 단계 더 좁힘 — 정책 변화 명시.
    if (!isPrivileged) {
      throw new ForbiddenException('정산 상세 내역은 관리자 전용입니다. 지급 내역은 내 페이 목록에서 확인하세요.');
    }
    return row;
  }


  /** 활성 강사 id 목록(일괄 산정 기본 대상). */
  activeInstructorIds(): number[] {
    return this.db
      .findBy<StaffAccount>(USERS, (a) => a.role === 'instructor' && a.status === 'active')
      .map((a) => a.id);
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
        // [80J F-3] 스캔은 가드 없는 코어 — 비활성 강사는 measure 0으로 자연 배제(라우트 가드는 measure()).
        const m = this.measureCore(instructor.id, periodStart, periodEnd);
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
    const isPrivileged = claimsHaveCapability(roles, 'finance.access');
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

}
