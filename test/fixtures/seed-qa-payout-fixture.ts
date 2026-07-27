import type { INestApplication } from '@nestjs/common';
import type { AuditLog } from '@kms545487/contracts';
import { BaseRow, InMemoryDatabase } from '../../src/database/in-memory.database';
import { AUDIT_LOG } from '../../src/modules/audit/audit.service';
import { InstructorPayoutRow, PAYOUTS } from '../../src/modules/payouts/payout.entity';
import { PayoutsService } from '../../src/modules/payouts/payouts.service';
import { ClassSession, SESSIONS } from '../../src/modules/schedule/schedule.entity';
import { ScheduleService } from '../../src/modules/schedule/schedule.service';
import { StaffAccount, USERS } from '../../src/modules/users/user.entity';

const QA_INSTRUCTOR_ID = 1;
const QA_SESSION_AMOUNTS = new Map([
  [20, 52_000],
  [22, 48_000],
]);

export type QaPendingPayoutFixture = {
  payout: InstructorPayoutRow;
  sessionIds: number[];
  auditRows: QaAuditRow[];
};

type QaAuditRow = AuditLog & BaseRow;

/**
 * Browser QA needs one editable pending payout. Build it through production command services so
 * payout lines, session reverse references, and audit rows obey the same UoW as user commands.
 * This helper is imported only by the hermetic QA server and E2E tests.
 */
export async function seedQaPendingPayoutFixture(app: INestApplication): Promise<QaPendingPayoutFixture> {
  const db = app.get(InMemoryDatabase);
  const actor = db.findBy<StaffAccount>(USERS, (user) => user.webId === 'admin')[0];
  if (!actor) throw new Error('[qa] admin actor is missing');
  const sessionIds = [...QA_SESSION_AMOUNTS.keys()];
  const existing = db.findBy<InstructorPayoutRow>(
    PAYOUTS,
    (payout) =>
      payout.status === 'pending' &&
      payout.instructorId === QA_INSTRUCTOR_ID &&
      sessionIds.every((id) => payout.lines.some((line) => line.sessionId === id)),
  )[0];
  if (existing) {
    return {
      payout: existing,
      sessionIds,
      auditRows: db.findBy<QaAuditRow>(
        AUDIT_LOG,
        (row) => row.entity === 'instructor_payouts' && row.entityId === existing.id,
      ),
    };
  }

  const sessions = sessionIds.map((id) => {
    const session = db.findById<ClassSession>(SESSIONS, id);
    if (!session) throw new Error(`[qa] payout fixture session ${id} is missing`);
    if (session.payoutId != null) throw new Error(`[qa] payout fixture session ${id} is already linked`);
    return session;
  });
  const from = sessions.map((session) => session.sessionDate).sort()[0];
  const to = sessions.map((session) => session.sessionDate).sort().at(-1);
  if (!from || !to) throw new Error('[qa] payout fixture period is empty');

  const schedule = app.get(ScheduleService);
  for (const [sessionId, amount] of QA_SESSION_AMOUNTS) {
    await schedule.setSessionPayAmount(sessionId, amount, actor.id);
  }
  const payout = await app.get(PayoutsService).generate(
    QA_INSTRUCTOR_ID,
    from,
    to,
    actor.id,
  );

  return {
    payout,
    sessionIds,
    auditRows: db.findBy<QaAuditRow>(
      AUDIT_LOG,
      (row) => row.entity === 'instructor_payouts' && row.entityId === payout.id,
    ),
  };
}
