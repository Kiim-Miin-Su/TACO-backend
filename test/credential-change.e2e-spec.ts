import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from './setup-app';
import { InMemoryDatabase } from '../src/database/in-memory.database';
import { AuditService } from '../src/modules/audit/audit.service';

type UserRow = {
  id: number;
  webId: string;
  authVersion?: number;
  mustChangePassword?: boolean;
  passwordHash: string;
  emailVerifyExpiresAt?: string | null;
};

describe('Credential change and first-login gate (e2e, TBO-29B)', () => {
  let app: INestApplication;
  let http: ReturnType<typeof request>;
  let db: InMemoryDatabase;

  beforeAll(async () => {
    app = await createTestApp();
    http = request(app.getHttpServer());
    db = app.get(InMemoryDatabase);
  });
  afterAll(async () => { await app.close(); });

  const login = async (webId: string, password: string) =>
    (await http.post('/api/auth/login').send({ webId, password }).expect(201)).body;

  it('CEO first login: both fields required, business blocked, atomic change invalidates old JWT', async () => {
    db.update<UserRow>('users', 3, { mustChangePassword: true });
    const initial = await login('admin', 'demo1234');
    expect(initial.account.mustChangePassword).toBe(true);

    await http.get('/api/students').set('Authorization', `Bearer ${initial.accessToken}`).expect(403);
    await http.get('/api/auth/pending').set('Authorization', `Bearer ${initial.accessToken}`).expect(403);
    await http.patch('/api/users/me/credentials').set('Authorization', `Bearer ${initial.accessToken}`)
      .send({ currentPassword: 'demo1234', newPassword: 'SecurePass123!' }).expect(400);
    await http.patch('/api/users/me/credentials').set('Authorization', `Bearer ${initial.accessToken}`)
      .send({ currentPassword: 'demo1234', newWebId: 'admin', newPassword: 'SecurePass123!' }).expect(400);
    await http.patch('/api/users/me/credentials').set('Authorization', `Bearer ${initial.accessToken}`)
      .send({ currentPassword: 'wrong-password', newWebId: 'ceo_owner', newPassword: 'SecurePass123!' }).expect(403);

    const changed = await http.patch('/api/users/me/credentials').set('Authorization', `Bearer ${initial.accessToken}`)
      .send({ currentPassword: 'demo1234', newWebId: 'ceo_owner', newPassword: 'SecurePass123!' }).expect(200);
    expect(changed.body).toMatchObject({ id: 3, webId: 'ceo_owner', mustChangePassword: false });
    expect(changed.body.passwordHash).toBeUndefined();

    await http.get('/api/auth/me').set('Authorization', `Bearer ${initial.accessToken}`).expect(401);
    await http.post('/api/auth/login').send({ webId: 'admin', password: 'demo1234' }).expect(401);
    const fresh = await login('ceo_owner', 'SecurePass123!');
    expect(fresh.account.mustChangePassword).toBe(false);
    await http.get('/api/students').set('Authorization', `Bearer ${fresh.accessToken}`).expect(200);

    const audit = db.findAll<Record<string, unknown> & { id: number }>('audit_log')
      .filter((row) => row.entity === 'users' && row.entityId === 3 && row.action === 'update');
    expect(audit).toHaveLength(1);
    const serialized = JSON.stringify(audit[0]);
    expect(serialized).not.toContain('demo1234');
    expect(serialized).not.toContain('SecurePass123!');
    expect(serialized).not.toContain('passwordHash');
  });

  it('duplicate webId returns 409 without changing credential state', async () => {
    const manager = await login('manager', 'demo1234');
    const before = { ...db.findById<UserRow>('users', 4)! };
    await http.patch('/api/users/me/credentials').set('Authorization', `Bearer ${manager.accessToken}`)
      .send({ currentPassword: 'demo1234', newWebId: 'park_inst', newPassword: 'ManagerPass123!' }).expect(409);
    const after = db.findById<UserRow>('users', 4)!;
    expect(after.webId).toBe(before.webId);
    expect(after.authVersion ?? 1).toBe(before.authVersion ?? 1);
    await login('manager', 'demo1234');
  });

  it('audit failure rolls back webId, password, flag, and authVersion', async () => {
    const manager = await login('manager', 'demo1234');
    const before = { ...db.findById<UserRow>('users', 4)! };
    const audit = app.get(AuditService);
    const spy = jest.spyOn(audit, 'log').mockRejectedValueOnce(new Error('injected audit failure'));
    await http.patch('/api/users/me/credentials').set('Authorization', `Bearer ${manager.accessToken}`)
      .send({ currentPassword: 'demo1234', newWebId: 'manager_new', newPassword: 'ManagerPass123!' }).expect(500);
    spy.mockRestore();
    const after = db.findById<UserRow>('users', 4)!;
    expect(after.webId).toBe(before.webId);
    expect(after.passwordHash).toBe(before.passwordHash);
    expect(after.mustChangePassword).toBe(before.mustChangePassword);
    expect(after.authVersion ?? 1).toBe(before.authVersion ?? 1);
    await login('manager', 'demo1234');
    await http.post('/api/auth/login').send({ webId: 'manager_new', password: 'ManagerPass123!' }).expect(401);
  });

  it('case-insensitive concurrent webId claim commits exactly once', async () => {
    const manager = await login('manager', 'demo1234');
    const admin = await login('prof_admin', 'demo1234');
    const [left, right] = await Promise.all([
      http.patch('/api/users/me/credentials').set('Authorization', `Bearer ${manager.accessToken}`)
        .send({ currentPassword: 'demo1234', newWebId: 'SharedOps', newPassword: 'ManagerPass123!' }),
      http.patch('/api/users/me/credentials').set('Authorization', `Bearer ${admin.accessToken}`)
        .send({ currentPassword: 'demo1234', newWebId: 'sharedops', newPassword: 'AdminSecure123!' }),
    ]);
    expect([left.status, right.status].sort()).toEqual([200, 409]);
    const owners = db.findAll<UserRow>('users').filter((user) => user.webId.toLowerCase() === 'sharedops');
    expect(owners).toHaveLength(1);
  });

  it('verification token is single-use and expired tokens are rejected', async () => {
    const stamp = Date.now();
    const signup = async (suffix: string) => {
      const webId = `verify_${suffix}_${stamp}`;
      const response = await http.post('/api/auth/signup').send({
        webId,
        name: `인증 ${suffix}`,
        email: `${webId}@example.test`,
        password: 'VerifyPass123!',
        role: 'instructor',
      }).expect(201);
      const token = new URL(response.body.devVerifyLink).searchParams.get('token');
      if (!token) throw new Error('dev verification token missing in test mode');
      return { webId, token };
    };

    const reusable = await signup('once');
    await http.get(`/api/auth/verify-email?token=${reusable.token}`).expect(200);
    await http.get(`/api/auth/verify-email?token=${reusable.token}`).expect(400);

    const expired = await signup('expired');
    const expiredAccount = db.findAll<UserRow>('users').find((user) => user.webId === expired.webId)!;
    db.update<UserRow>('users', expiredAccount.id, { emailVerifyExpiresAt: '2000-01-01T00:00:00.000Z' });
    await http.get(`/api/auth/verify-email?token=${expired.token}`).expect(400);
  });
});
