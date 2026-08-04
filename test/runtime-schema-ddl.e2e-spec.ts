import {
  assertRuntimeRoleBoundary,
  PostgresConnectionService,
  runtimeSchemaDdlEnabled,
} from '../src/database/postgres-connection.service';

describe('production runtime schema DDL boundary', () => {
  const previousNodeEnv = process.env.NODE_ENV;
  const previousRuntimeDdl = process.env.RUNTIME_SCHEMA_DDL;

  afterEach(() => {
    process.env.NODE_ENV = previousNodeEnv;
    if (previousRuntimeDdl == null) delete process.env.RUNTIME_SCHEMA_DDL;
    else process.env.RUNTIME_SCHEMA_DDL = previousRuntimeDdl;
    jest.restoreAllMocks();
  });

  it('disables runtime DDL by default in production', async () => {
    process.env.NODE_ENV = 'production';
    delete process.env.RUNTIME_SCHEMA_DDL;
    const service = new PostgresConnectionService();
    const query = jest.spyOn(service, 'query').mockResolvedValue([]);

    expect(runtimeSchemaDdlEnabled()).toBe(false);
    await service.ddl('CREATE TABLE should_not_run (id integer)');
    expect(query).not.toHaveBeenCalled();
  });

  // [TBO-34 C2-C 2026-07-23] 구 계약 "production 복구 오버라이드 허용"을 폐기 — C2-C 수용 기준
  //  "production DDL 재활성화 fail-fast"에 따라 env 뒷문 자체를 부팅·호출 시점에 끊는다.
  //  (복구가 필요하면 versioned migration으로만 — 런북 절차.)
  it('rejects an explicit production re-enable attempt (fail-fast)', async () => {
    process.env.NODE_ENV = 'production';
    process.env.RUNTIME_SCHEMA_DDL = 'true';
    const service = new PostgresConnectionService();
    const query = jest.spyOn(service, 'query').mockResolvedValue([]);

    expect(() => runtimeSchemaDdlEnabled()).toThrow(/versioned migration/);
    await expect(service.ddl('CREATE TABLE recovery_override (id integer)')).rejects.toThrow(/versioned migration/);
    expect(query).not.toHaveBeenCalled();
  });

  it('keeps local and test schema bootstrap behavior', () => {
    process.env.NODE_ENV = 'test';
    delete process.env.RUNTIME_SCHEMA_DDL;
    expect(runtimeSchemaDdlEnabled()).toBe(true);
  });

  it('rejects a production runtime role with schema CREATE', () => {
    process.env.NODE_ENV = 'production';
    expect(() => assertRuntimeRoleBoundary({ role: 'neondb_owner', schemaCreate: true }))
      .toThrow(/DML 전용 역할/);
    expect(() => assertRuntimeRoleBoundary({ role: 'taco_runtime', schemaCreate: false }))
      .not.toThrow();
  });
});
