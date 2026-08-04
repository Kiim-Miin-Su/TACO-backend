import { InMemoryDatabase } from '../src/database/in-memory.database';
import { AccountStateService } from '../src/database/account-state.service';
import type { PostgresConnectionService } from '../src/database/postgres-connection.service';

describe('AccountStateService authorization projection', () => {
  it('loads account state and capability overrides in one Postgres round trip', async () => {
    const postgres = {
      ready: true,
      ensureInitialized: jest.fn().mockResolvedValue(undefined),
      query: jest.fn().mockResolvedValue([
        {
          name: '강사', role: 'instructor', status: 'active', auth_version: 4,
          must_change_password: false, deleted_at: null,
          override_capability: 'calendar.manage', override_effect: 'allow',
        },
        {
          name: '강사', role: 'instructor', status: 'active', auth_version: 4,
          must_change_password: false, deleted_at: null,
          override_capability: 'calendar.request-own', override_effect: 'deny',
        },
      ]),
    } as unknown as PostgresConnectionService;
    const service = new AccountStateService(new InMemoryDatabase(), postgres);

    const verdict = await service.verifyClaims({ sub: 7, roles: ['instructor'], authVersion: 4 });

    expect(postgres.query).toHaveBeenCalledTimes(1);
    expect(verdict).toMatchObject({ ok: true, name: '강사', role: 'instructor' });
    if (!verdict.ok) throw new Error('authorization projection unexpectedly rejected');
    expect(verdict.effectiveCapabilities).toContain('calendar.manage');
    expect(verdict.effectiveCapabilities).not.toContain('calendar.request-own');
  });
});
