import 'reflect-metadata';
import { config } from 'dotenv';
import * as bcrypt from 'bcryptjs';
import request from 'supertest';
import { createTestApp } from '../test/setup-app';
import { PostgresConnectionService } from '../src/database/postgres-connection.service';

config({ path: process.env.DOTENV_CONFIG_PATH ?? '.env.local', override: false });

// ─────────────────────────────────────────────────────────────
// [TBO-33 2026-07-20 대표 지시 "전부 영속화"] 재기동 생존 스모크 — serverless 콜드스타트 시뮬레이션.
//  앱#1에서 API로 기록(학생→상담 폼→상담 회차→보고서 템플릿) → 앱#1 종료 → 앱#2 부팅(hydrate)
//  → 전부 생존을 실 DB에서 검증한다. 기존 calendar-assets 스모크(가용/프리셋)와 짝을 이뤄
//  "영속 전환 마지막 5표"의 재기동 생존을 회귀 방지 게이트로 고정한다.
//  · 자격증명: SMOKE_ADMIN_WEBID/SMOKE_ADMIN_PASSWORD(기존 스모크 규약). 비밀번호는 로그 미기록.
//  · 빈 로컬 DB 편의: users가 0행이고 비production이며 SMOKE_ADMIN_PASSWORD 미지정일 때만
//    스모크 전용 admin(super_admin·demo1234)을 직접 INSERT해 자가 프로비저닝한다.
//    production에서는 절대 프로비저닝하지 않는다(기존 계정 필수).
// ─────────────────────────────────────────────────────────────

const SMOKE_ADMIN_WEBID = process.env.SMOKE_ADMIN_WEBID ?? 'admin';
const smokeAdminPassword = (): string => process.env.SMOKE_ADMIN_PASSWORD ?? 'demo1234';
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

function requireEnv(): void {
  if (!process.env.DATABASE_URL && !process.env.POSTGRES_URL && !process.env.POSTGRES_PRISMA_URL) {
    throw new Error('DATABASE_URL/POSTGRES_URL is required for persistence restart smoke');
  }
}

async function login(http: ReturnType<typeof request>): Promise<string> {
  const res = await http.post('/api/auth/login')
    .send({ webId: SMOKE_ADMIN_WEBID, password: smokeAdminPassword() }).expect(201);
  return res.body.accessToken;
}

/** 빈 로컬 DB 자가 프로비저닝 — 비production + users 0행 + SMOKE_ADMIN_PASSWORD 미지정일 때만. */
async function provisionLocalAdminIfEmpty(pg: PostgresConnectionService): Promise<void> {
  if (process.env.NODE_ENV === 'production') return;
  if (process.env.SMOKE_ADMIN_PASSWORD) return; // 실 DB 게이트 — 기존 계정 사용
  const [{ n }] = await pg.query<{ n: string }>('SELECT COUNT(*)::int AS n FROM users');
  if (Number(n) > 0) return;
  const hash = await bcrypt.hash(smokeAdminPassword(), 12);
  await pg.query(
    `INSERT INTO users (web_id, name, role, status, password_hash, email_verified, auth_version, profile_version, must_change_password)
     VALUES ($1, '스모크대표', 'super_admin', 'active', $2, true, 1, 1, false)`,
    [SMOKE_ADMIN_WEBID, hash],
  );
  console.log('[restart-smoke] empty local DB — provisioned smoke super_admin');
}

async function main(): Promise<void> {
  requireEnv();
  const stamp = Date.now();
  let studentId = 0;
  let formId = 0;
  let roundId = 0;
  let templateId = 0;
  const templateName = `restart-smoke-${stamp}`;

  {
    console.log('[restart-smoke] boot app #1');
    const app = await createTestApp();
    const pg = app.get(PostgresConnectionService);
    if (!pg.ready) throw new Error('Postgres data source is not ready');
    await provisionLocalAdminIfEmpty(pg);
    const http = request(app.getHttpServer());
    const admin = await login(http);

    console.log('[restart-smoke] write: student → counsel form → round → report template');
    const studentRes = await http.post('/api/students').set(auth(admin)).send({
      student: {
        name: `재기동학생-${stamp}`, gender: 'undisclosed', birthDate: '2012-07-21', grade: 8,
        country: 'KR', residenceType: 'domestic', address: '서울시', schoolName: 'TACO School',
        phone: '010-9000-0000', counselTopic: '학습 상담', status: 'new_inquiry',
      },
      interests: [
        { customLabel: '재기동 검증 희망 수업 1', priority: 1 },
        { customLabel: '재기동 검증 희망 수업 2', priority: 2 },
      ], // DTO ArrayMinSize(2) — 코스 없이 customLabel 2건
    });
    if (studentRes.status !== 201) throw new Error('student create ' + studentRes.status + ': ' + JSON.stringify(studentRes.body?.message ?? studentRes.body));
    const student = studentRes.body.student;
    studentId = student.id;

    const form = (await http.post('/api/counsel').set(auth(admin))
      .send({ studentId, source: 'manual' }).expect(201)).body;
    formId = form.id;
    const round = (await http.post(`/api/counsel/${formId}/rounds`).set(auth(admin))
      .send({
        summary: '재기동 생존 검증 상담',
        result: 'positive',
        nextContactAt: '2026-08-01T00:00:00.000Z',
      }).expect(201)).body;
    roundId = round.id;

    const template = (await http.post('/api/report-templates').set(auth(admin))
      .send({ name: templateName, content: '재기동 후에도 남아야 한다', homework: '없음' }).expect(201)).body;
    templateId = template.id;

    await app.close();
  }

  {
    console.log('[restart-smoke] boot app #2 (cold start simulation)');
    const app = await createTestApp();
    const http = request(app.getHttpServer());
    const admin = await login(http);

    const forms = (await http.get('/api/counsel').set(auth(admin)).expect(200)).body as Array<{ id: number; nextContactAt?: string }>;
    const form = forms.find((row) => row.id === formId);
    if (!form) throw new Error(`counsel form ${formId} did not survive restart`);
    if (!String(form.nextContactAt ?? '').includes('2026-08-01')) {
      throw new Error(`counsel form ${formId} nextContactAt sync did not survive restart`);
    }
    const rounds = (await http.get(`/api/counsel/rounds?counselFormId=${formId}`).set(auth(admin)).expect(200)).body as Array<{ id: number; summary?: string }>;
    if (!rounds.some((row) => row.id === roundId && row.summary === '재기동 생존 검증 상담')) {
      throw new Error(`counsel round ${roundId} did not survive restart`);
    }
    const templates = (await http.get('/api/report-templates').set(auth(admin)).expect(200)).body as Array<{ id: number; name: string }>;
    if (!templates.some((row) => row.id === templateId && row.name === templateName)) {
      throw new Error(`report template ${templateId} did not survive restart`);
    }
    const students = (await http.get('/api/students').set(auth(admin)).expect(200)).body as Array<{ id: number }>;
    if (!students.some((row) => row.id === studentId)) {
      throw new Error(`student ${studentId} did not survive restart`);
    }
    await app.close();
  }

  console.log(JSON.stringify({ ok: true, studentId, formId, roundId, templateId }));
}

main().catch((err) => {
  console.error(err instanceof Error ? (err.stack ?? err.message) : err);
  process.exitCode = 1;
});
