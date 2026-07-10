import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException, OnModuleInit } from '@nestjs/common';
import { InMemoryDatabase } from '../../database/in-memory.database';
import { SESSION_REPORTS_SPEC } from '../../database/calendar-asset-specs';
import { PostgresCollectionStore } from '../../database/postgres-collection.store';
import { ADMIN_ROLES } from '../auth/roles.decorator';
import { ClassSession, SESSIONS } from '../schedule/schedule.entity';
import { Course, COURSES } from '../courses/course.entity';
import { SessionReportRow, SESSION_REPORTS } from './report.entity';
import { CreateReportDto } from './dto/create-report.dto';

// [보안 2026-07-07 H2] 액터 컨텍스트 — 비관리자(강사)는 본인 세션·본인 보고서만 쓰기 가능(IDOR 차단).
export type ReportActor = { id: number; roles: string[] };
const actorIsAdmin = (actor?: ReportActor) => !!actor && actor.roles.some((r) => (ADMIN_ROLES as string[]).includes(r));

/**
 * 수업 보고서 — 강사 제출 → 관리자 승인/반려.
 * 시수/페이 산정은 '승인된 보고서가 있는 held 세션'만 대상으로 하므로,
 * 여기서 세션 FK·중복(세션×학생)·강사 일치 등 참조 무결성을 먼저 지킨다.
 */
@Injectable()
export class ReportsService implements OnModuleInit {
  constructor(
    private readonly db: InMemoryDatabase,
    private readonly store: PostgresCollectionStore,
  ) {}

  // 데모 보고서 시드 — 과거 held 세션(schedule 히스토리 20~28)의 일부만 제출(submitted).
  //  → 리포트 현황 대시보드에서 "작성/미작성"이 섞여 보임(전 슬롯 8개 중 3건 작성). 승인(approved) 아님 = 시수/정산 미반영(payouts 불변).
  //  고정 id로 멱등, payouts가 런타임 생성하는 승인 보고서(nextId)와 충돌 없음.
  async onModuleInit(): Promise<void> {
    const hydrated = await this.store.hydrate<SessionReportRow>(SESSION_REPORTS_SPEC);
    if (hydrated.length) return;
    await this.store.seed<SessionReportRow>(SESSION_REPORTS_SPEC, [
      { id: 1, sessionId: 20, studentId: 1, instructorId: 1, content: '주제·요지 파악 향상. 근거 문장 매칭 연습 필요.', status: 'submitted', approvalStatus: 'submitted', submittedAt: new Date().toISOString() },
      { id: 2, sessionId: 21, studentId: 2, instructorId: 2, content: '미분 응용 개념 이해. 연쇄법칙 반복.', status: 'submitted', approvalStatus: 'submitted', submittedAt: new Date().toISOString() },
      { id: 3, sessionId: 26, studentId: 1, instructorId: 1, content: '추론 문제 정답률 상승. 어휘 20개 암기 과제.', status: 'submitted', approvalStatus: 'submitted', submittedAt: new Date().toISOString() },
    ]);
  }

  findAll(): SessionReportRow[] {
    return this.db.findAll<SessionReportRow>(SESSION_REPORTS);
  }

  findOne(id: number): SessionReportRow {
    const row = this.db.findById<SessionReportRow>(SESSION_REPORTS, id);
    if (!row) throw new NotFoundException(`Report ${id} not found`);
    return row;
  }

  findBySession(sessionId: number): SessionReportRow[] {
    return this.db.findByField<SessionReportRow>(SESSION_REPORTS, 'sessionId', sessionId); // 인덱스 조회
  }

  // 승인된 보고서가 있는 세션 id 집합 — 시수 적격성 판정에 사용(payouts에서 호출).
  approvedSessionIds(): Set<number> {
    return new Set(
      this.db
        .findBy<SessionReportRow>(SESSION_REPORTS, (r) => r.approvalStatus === 'approved')
        .map((r) => r.sessionId),
    );
  }

  async create(dto: CreateReportDto, actor?: ReportActor): Promise<SessionReportRow> {
    // 1) 세션 FK 검증
    const session = this.db.findById<ClassSession>(SESSIONS, dto.sessionId);
    if (!session) throw new BadRequestException(`sessionId ${dto.sessionId} 없음(존재하지 않는 수업)`);

    // 2) 소유권(H2 IDOR 차단) — 비관리자(강사)는 본인 담당 세션에만 작성 가능.
    if (actor && !actorIsAdmin(actor) && session.instructorId !== actor.id)
      throw new ForbiddenException('담당 강사 또는 관리자만 이 세션의 보고서를 작성할 수 있습니다.');

    // 3) 강사 일치(미지정 시 세션 강사로 채움)
    const instructorId = dto.instructorId ?? session.instructorId;
    if (instructorId !== session.instructorId)
      throw new BadRequestException(
        `보고서 강사(${instructorId})가 세션 강사(${session.instructorId})와 불일치`,
      );

    // 3) (세션, 학생) 중복 보고서 금지 — ERD unique(session_id, student_id)
    const dup = this.db.findBy<SessionReportRow>(
      SESSION_REPORTS,
      (r) => r.sessionId === dto.sessionId && r.studentId === dto.studentId,
    );
    if (dup.length) throw new ConflictException(`세션 ${dto.sessionId}·학생 ${dto.studentId} 보고서가 이미 존재`);

    // 4) 과목 스냅샷(코스 조인) — 코스가 있으면 subjectId 보존
    const course = this.db.findById<Course>(COURSES, session.courseId);
    const status = dto.status ?? 'submitted';
    return this.store.insert<SessionReportRow>(SESSION_REPORTS_SPEC, {
      sessionId: dto.sessionId,
      studentId: dto.studentId,
      instructorId,
      subjectId: course?.subjectId,
      content: dto.content,
      homework: dto.homework,
      status,
      approvalStatus: status === 'submitted' ? 'submitted' : 'draft',
      submittedAt: status === 'submitted' ? new Date().toISOString() : undefined,
    });
  }

  // 강사: 작성완료 제출(draft → submitted)
  async submit(id: number, actor?: ReportActor): Promise<SessionReportRow> {
    const r = this.findOne(id);
    // 소유권(H2 IDOR 차단) — 비관리자는 본인 명의 보고서만 제출 가능.
    if (actor && !actorIsAdmin(actor) && r.instructorId !== actor.id)
      throw new ForbiddenException('담당 강사 또는 관리자만 이 보고서를 제출할 수 있습니다.');
    if (r.approvalStatus === 'approved') throw new BadRequestException('이미 승인된 보고서');
    return await this.store.update<SessionReportRow>(SESSION_REPORTS_SPEC, id, {
      status: 'submitted',
      approvalStatus: 'submitted',
      submittedAt: new Date().toISOString(),
      rejectedReason: undefined,
    }) as SessionReportRow;
  }

  // 관리자 승인(submitted → approved) — 승인 시 시수 적격 세션으로 편입
  async approve(id: number, approvedBy?: number): Promise<SessionReportRow> {
    const r = this.findOne(id);
    if (r.approvalStatus !== 'submitted')
      throw new BadRequestException(`승인 불가 상태(${r.approvalStatus ?? r.status}) — submitted만 승인 가능`);
    return await this.store.update<SessionReportRow>(SESSION_REPORTS_SPEC, id, {
      approvalStatus: 'approved',
      approvedAt: new Date().toISOString(),
      approvedBy,
    }) as SessionReportRow;
  }

  // 관리자 반려(→ rejected, 사유 보존). 재제출 가능.
  async reject(id: number, reason?: string): Promise<SessionReportRow> {
    const r = this.findOne(id);
    if (r.approvalStatus === 'approved')
      throw new BadRequestException('이미 승인됨 — 반려하려면 정산 회수 후 처리 필요');
    return await this.store.update<SessionReportRow>(SESSION_REPORTS_SPEC, id, {
      approvalStatus: 'rejected',
      rejectedReason: reason ?? '사유 미기재',
    }) as SessionReportRow;
  }

  async removeBySession(sessionId: number, deletedBy?: number): Promise<number> {
    const rows = this.db.findByField<SessionReportRow>(SESSION_REPORTS, 'sessionId', sessionId);
    let deleted = 0;
    for (const row of rows) {
      if (await this.store.remove(SESSION_REPORTS_SPEC, row.id, deletedBy)) deleted += 1;
    }
    return deleted;
  }
}
