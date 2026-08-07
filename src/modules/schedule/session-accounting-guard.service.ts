import { ConflictException, Injectable } from '@nestjs/common';
import type { AccountingAckInput } from '@kms545487/contracts';
import { CoursesService } from '../courses/courses.service';
import type { ClassSession } from './schedule.entity';
import {
  accountingImpactHash,
  accountingImpactOf,
  isPayoutLocked,
  type SessionAccountingImpact,
  type SessionPricingInput,
} from './session-accounting.policy';
import {
  SessionAccountingContextService,
  type SessionAccountingContext,
} from './session-accounting-context.service';

/** 회계 영향 확인 공통 입력 — [SSOT 감사 2026-08-07] 로컬 사본 제거, contracts가 단일 소스
 *  (Clear/SetInstructorAttendance/RejectReport 등 4개 입력의 기반 타입 — 계약 드리프트 방지). */
export type { AccountingAckInput };

type ImpactShape = Pick<ClassSession, 'courseId' | 'instructorId' | 'studentIds'>
  & Parameters<typeof accountingImpactOf>[0];

/**
 * [TBO-79 B4~B6] 회계 영향 미리보기 + 명시 확인(ack)의 **단일 집행 지점**.
 *
 * 종전엔 `PATCH /schedule/:id`와 `DELETE /schedule/:id`에만 게이트가 있었고, 같은 델타를 만드는
 * 두 경로가 그대로 통과했다.
 *  · `DELETE /attendance/:sessionId/:studentId` — held → scheduled 역전이. 심지어 담당 **강사**에게
 *    열려 있어, 권한이 더 높은 매니저의 수업 수정보다 방어가 약했다.
 *  · `POST /reports/:id/reject` — 승인 리포트를 되돌려 정산 적격에서 빼낸다.
 * 두 경로 모두 `accountingImpactAcknowledgement` audit 키를 남기지 않아 "무엇을 보고 승인했는가"가
 * 재구성되지 않았다.
 *
 * 반드시 **세션 advisory lock 획득 후** 호출한다 — 영향은 잠금 스냅샷에서 계산해야 사용자가 본
 * 미리보기와 실제 적용 대상이 결속된다.
 */
@Injectable()
export class SessionAccountingGuard {
  constructor(
    private readonly context: SessionAccountingContextService,
    private readonly courses: CoursesService,
  ) {}

  private inputFor(
    context: SessionAccountingContext,
    sessionId: number,
    shape: Pick<ClassSession, 'courseId' | 'instructorId' | 'studentIds'>,
    exclude?: { attendanceStudentIds?: readonly number[]; approvedReportStudentIds?: readonly number[] },
  ): SessionPricingInput {
    const base = this.context.pricingInputFor(
      context,
      sessionId,
      shape,
      this.courses.effectiveHourlyRateFor(Number(shape.courseId), shape.instructorId),
    );
    if (!exclude?.attendanceStudentIds?.length && !exclude?.approvedReportStudentIds?.length) return base;
    const clearedAttendance = new Set((exclude.attendanceStudentIds ?? []).map(Number));
    const clearedReports = new Set((exclude.approvedReportStudentIds ?? []).map(Number));
    return {
      ...base,
      attendanceOf: (studentId) => (clearedAttendance.has(Number(studentId)) ? undefined : base.attendanceOf(studentId)),
      reportOf: (studentId) => (clearedReports.has(Number(studentId)) ? undefined : base.reportOf(studentId)),
    };
  }

  /**
   * 잠금 스냅샷에서 before/after 영향을 계산한다.
   * `removes*`는 이 명령이 after 쪽에서 없애는 종속 행 — 출결 초기화·리포트 승인 취소가 여기 해당한다.
   */
  async evaluate(params: {
    context: SessionAccountingContext;
    before: ImpactShape;
    after: ImpactShape;
    sessionId: number;
    removesAttendanceForStudentIds?: readonly number[];
    removesApprovedReportForStudentIds?: readonly number[];
  }): Promise<{ impact: SessionAccountingImpact; impactHash: string }> {
    const impact = accountingImpactOf(params.before, params.after, {
      before: this.inputFor(params.context, params.sessionId, params.before),
      after: this.inputFor(params.context, params.sessionId, params.after, {
        attendanceStudentIds: params.removesAttendanceForStudentIds,
        approvedReportStudentIds: params.removesApprovedReportForStudentIds,
      }),
    });
    return { impact, impactHash: accountingImpactHash([params.sessionId], impact) };
  }

  /**
   * 영향이 있는데 확인이 없거나 지문이 다르면 409. 반환값이 true면 호출자는 audit changes에
   * `accountingImpactAcknowledgement`를 기록해야 한다(B6).
   *
   * 정산에 연결된 세션은 ack로도 우회할 수 없다 — 회수가 선행이라 PAYOUT_REVERSAL_REQUIRED다.
   */
  assertAcknowledged(
    session: Parameters<typeof isPayoutLocked>[0],
    evaluated: { impact: SessionAccountingImpact; impactHash: string },
    dto: AccountingAckInput | undefined,
    messages: { locked: string; ack: string },
  ): boolean {
    const { impact, impactHash } = evaluated;
    if (isPayoutLocked(session)) {
      throw new ConflictException({
        code: 'PAYOUT_REVERSAL_REQUIRED',
        message: messages.locked,
        impact,
        impactHash,
      });
    }
    if (!impact.changed) return false;
    if (!dto?.acknowledgeAccountingImpact || dto.expectedAccountingImpactHash !== impactHash) {
      throw new ConflictException({
        code: 'ACCOUNTING_IMPACT_ACK_REQUIRED',
        message: dto?.acknowledgeAccountingImpact
          ? '확인한 회계 영향이 현재 상태와 달라졌습니다. 최신 영향 미리보기를 다시 확인하세요.'
          : messages.ack,
        impact,
        impactHash,
      });
    }
    return true;
  }

  /** audit changes에 붙일 확인 지문 — schedule의 update/delete와 동일 규약. */
  acknowledgementDiff(evaluated: { impact: SessionAccountingImpact; impactHash: string }) {
    return {
      accountingImpactAcknowledgement: {
        before: null,
        after: { hash: evaluated.impactHash, impact: evaluated.impact },
      },
    };
  }
}
