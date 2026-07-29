// [TBO-69 C2 2026-07-26] 정산 **명령(Command) 서비스** — 산정·목록·미정산 감지 등 읽기는
//  payouts-read.service로 분리(본문 이동 — 규약 무변). 명령은 읽기를 단방향 주입해 경유한다.
import { BadRequestException, ConflictException, Injectable, Logger } from '@nestjs/common';
import { InMemoryDatabase } from '../../database/in-memory.database';
import { INSTRUCTOR_PAYOUTS_SPEC, TRANSACTIONS_SPEC } from '../../database/calendar-asset-specs';
import { PostgresCollectionStore } from '../../database/postgres-collection.store';
import { ClassSession, SESSIONS } from '../schedule/schedule.entity';

import { ClassSessionsStore } from '../schedule/class-sessions.store';
import { CalendarUnitOfWork } from '../../database/calendar-unit-of-work.service';
import { CoursesService } from '../courses/courses.service';
import { AuditService } from '../audit/audit.service';
import { PayoutReadinessService } from './payout-readiness.service';
import { PayoutsReadService } from './payouts-read.service'; // [TBO-69 C2]
import {
  InstructorPayoutRow,
  TransactionRow,
} from './payout.entity';

// 세션 행은 정산 연결 payoutId와 사용자 책정가 override를 갖는다. 산정 스냅샷은 payout.lines가 정본이다.
type SessionWithPayout = ClassSession & {
  payoutId?: number; instructorPayAmount?: number;
  // [TBO-32 C1 2026-07-20] 지급 이력·무결성 — is_paid(지급 완료 플래그·회수 시에만 false 복귀),
  //  paid_payout_id(마지막 지급 정산서 — 회수로 payoutId가 끊겨도 이력 잔존).
  isPaid?: boolean; paidPayoutId?: number | null;
};

// [TBO-69 C2] MeasureResult·산정은 payouts-read.service가 정본 — 하위 호환 재수출.
export type { MeasureResult } from './payouts-read.service';

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
export class PayoutsService {
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
    private readonly read: PayoutsReadService, // [TBO-69 C2] 읽기 단방향 주입
  ) {}

  // 정산서 생성(pending) + 세션 연결(payoutId → 이중 계상 방지, 금액 스냅샷은 payout.lines).
  // [리뷰 P0-4 2026-07-20] 잠금 후 재하이드레이트 — 멀티 인스턴스(serverless)에서 스테일 메모리로
  //  적격성(취소·보고서 반려를 못 본 계상)·상태 전이를 판정하지 않도록, payout 경로도 schedule의
  //  lock→refreshAfterLock 규약에 편입한다. 세션·보고서·정산서 세 자산이 판정 입력의 전부다.
  private async refreshAfterLock(): Promise<void> {
    await this.read.refreshReadInputs(); // [TBO-69 C2] 판정 입력 표 목록 = 읽기 서비스 단일 정본
  }

  /**
   * Payout command의 공통 경쟁 경계.
   * advisory lock 뒤 DB에서 행을 다시 읽고, status/amount/updatedAt을 한 CAS revision으로 사용한다.
   * updatedAt은 BaseRow의 영속 revision이며 별도 메모리 전용 버전 필드를 만들지 않는다.
   */
  private async lockedPayout(id: number): Promise<InstructorPayoutRow> {
    await this.unitOfWork.lockTargets([{ kind: 'payout', id }]);
    // memory mode의 findActive는 저장 행 참조를 반환하므로 detached snapshot으로 정규화한다.
    // 그렇지 않으면 updateIf가 before 행까지 mutate해 audit.before가 after와 같아진다.
    return structuredClone(await this.read.payoutFromDb(id));
  }

  private payoutCas(payout: InstructorPayoutRow): Partial<InstructorPayoutRow> {
    return {
      status: payout.status,
      amount: payout.amount,
      updatedAt: payout.updatedAt,
    };
  }

  async generate(instructorId: number, from: string, to: string, actorId?: number): Promise<InstructorPayoutRow> {
    // [원자성] 정산서 생성 + 세션 payoutId 연결이 함께 성공/실패(이중계상 방지 불변식 보호)
    return this.unitOfWork.run(async () => {
      // [리뷰 P0-4] 강사 단위 직렬화 + 잠금 후 재하이드레이트 — 스테일 메모리 계상 차단.
      await this.unitOfWork.lockTargets([{ kind: 'instructor', id: instructorId }]);
      await this.refreshAfterLock();
      let m = this.read.measure(instructorId, from, to);
      if (m.sessionCount === 0)
        throw new BadRequestException('정산 대상 세션이 없습니다(진행 완료 + 승인 보고서 필요)');
      // 회차별 override와 정산 생성이 같은 session advisory lock을 공유한다. 잠금 대기 중
      // 출결·리포트·책정가가 바뀔 수 있으므로 획득 뒤 fresh read로 산정 스냅샷을 다시 만든다.
      await this.unitOfWork.lockTargets(m.lines.map((line) => ({ kind: 'session' as const, id: line.sessionId })));
      await this.refreshAfterLock();
      m = this.read.measure(instructorId, from, to);
      if (m.sessionCount === 0)
        throw new ConflictException('산정 대상 회차가 다른 요청에서 먼저 변경되었습니다. 다시 산정해 주세요.');

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
        const claimed = await this.sessionsStore.claimPayout(l.sessionId, payout.id);
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
    const targets = instructorIds?.length ? instructorIds : this.read.activeInstructorIds();
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

  // 대표 확정(pending → confirmed)
  async confirm(id: number, actorId?: number): Promise<InstructorPayoutRow> {
    // [감사 전수 2026-07-16] 상태전환 + 이력 원자화(uow — 이력 실패 시 전환도 롤백).
    return this.unitOfWork.run(async () => {
      const p = await this.lockedPayout(id);
      if (p.status === 'confirmed') throw new ConflictException('이미 확정된 정산입니다');
      if (p.status !== 'pending') throw new BadRequestException(`확정 불가 상태(${p.status})`);
      const updated = await this.store.updateIf<InstructorPayoutRow>(INSTRUCTOR_PAYOUTS_SPEC, id, this.payoutCas(p), {
        status: 'confirmed',
        confirmedAt: new Date().toISOString(),
      });
      if (!updated) throw new ConflictException('정산 상태가 다른 요청에서 먼저 변경되었습니다');
      if (actorId != null) {
        await this.audit.log({
          entity: 'instructor_payouts', entityId: id, action: 'approve', actorId,
          changes: {
            status: { before: 'pending', after: 'confirmed' },
            amount: { before: p.amount, after: updated.amount },
          },
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
      const p = this.read.findOne(id);
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
      const p = await this.lockedPayout(id);
      if (p.status === 'paid' || p.status === 'rejected')
        throw new BadRequestException(`수정 불가 상태(${p.status})`);
      if (amount == null || amount < 0) throw new BadRequestException('수정 금액은 0 이상이어야 합니다');
      const updated = await this.store.updateIf<InstructorPayoutRow>(INSTRUCTOR_PAYOUTS_SPEC, id, this.payoutCas(p), {
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
      this.moneyLog.log(
        `action=adjust payout=${id} actor=${actorId ?? 0} before=${p.amount} after=${amount} result=success`,
      );
      return updated;
    });
  }

  // 대표 반려(→ rejected) + 연결 세션 회수(payoutId 해제 → 재산정 가능).
  async reject(id: number, reason?: string, actorId?: number): Promise<InstructorPayoutRow> {
    // [원자성] 반려 상태 + 연결 세션 전량 회수(부분 회수 잔존 금지)
    return this.unitOfWork.run(async () => {
      // [TBO-56 C2b] 강사 단위 lock + 재수화 — 세션 회수 판정(payoutId===id)을 DB 기준으로(회수 누락 차단).
      const scoped = await this.read.payoutFromDb(id);
      await this.unitOfWork.lockTargets([{ kind: 'instructor', id: scoped.instructorId }]);
      await this.refreshAfterLock();
      const p = await this.read.payoutFromDb(id);
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
          });
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
      const p = this.read.findOne(id);
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
            isPaid: false,
          });
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
      const p = this.read.findOne(id);
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
          await this.sessionsStore.update(l.sessionId, { isPaid: true, paidPayoutId: id });
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
