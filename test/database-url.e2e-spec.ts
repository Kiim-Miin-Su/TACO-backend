import {
  buildRuntimeRoleUrl,
  directDatabaseUrl,
  runtimeDatabaseUrl,
  runtimeRoleConnectionBaseUrl,
} from '../src/database/database-url';

describe('database URL role boundary', () => {
  const keys = [
    'RUNTIME_DATABASE_URL',
    'DATABASE_URL',
    'DATABASE_URL_UNPOOLED',
    'POSTGRES_URL',
    'POSTGRES_URL_NON_POOLING',
    'POSTGRES_PRISMA_URL',
    'RUNTIME_ROLE_CONNECTION_BASE_URL',
  ] as const;
  const before = Object.fromEntries(keys.map((key) => [key, process.env[key]]));

  beforeEach(() => {
    for (const key of keys) delete process.env[key];
  });

  afterAll(() => {
    for (const key of keys) {
      const value = before[key];
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('runtime은 integration owner URL보다 DML 전용 URL을 우선한다', () => {
    process.env.RUNTIME_DATABASE_URL = 'postgresql://runtime@example/runtime';
    process.env.DATABASE_URL = 'postgresql://owner@example/owner';

    expect(runtimeDatabaseUrl()).toBe('postgresql://runtime@example/runtime');
  });

  it('migration direct URL은 runtime URL과 분리된다', () => {
    process.env.RUNTIME_DATABASE_URL = 'postgresql://runtime@example/runtime';
    process.env.DATABASE_URL_UNPOOLED = 'postgresql://owner@example/owner';

    expect(runtimeDatabaseUrl()).toBe('postgresql://runtime@example/runtime');
    expect(directDatabaseUrl()).toBe('postgresql://owner@example/owner');
  });

  it('runtime role 연결원은 pooled integration URL을 우선한다', () => {
    process.env.DATABASE_URL = 'postgresql://owner@pooler.example/app';
    process.env.DATABASE_URL_UNPOOLED = 'postgresql://owner@direct.example/app';

    expect(runtimeRoleConnectionBaseUrl()).toBe('postgresql://owner@pooler.example/app');
  });

  it('runtime role URL은 pooled 연결 설정을 유지하면서 자격만 교체한다', () => {
    const result = new URL(buildRuntimeRoleUrl(
      'postgresql://owner@direct.example/app?sslmode=verify-full',
      'postgresql://owner@pooler.example/app?sslmode=verify-full&pgbouncer=true',
      'taco_runtime',
      'safe-password',
    ));

    expect(result.host).toBe('pooler.example');
    expect(result.username).toBe('taco_runtime');
    expect(result.password).toBe('safe-password');
    expect(result.searchParams.get('pgbouncer')).toBe('true');
  });

  it('다른 database의 runtime 연결원은 거부한다', () => {
    expect(() => buildRuntimeRoleUrl(
      'postgresql://owner@direct.example/app',
      'postgresql://owner@pooler.example/other',
      'taco_runtime',
      'safe-password',
    )).toThrow('database가 다릅니다');
  });
});
