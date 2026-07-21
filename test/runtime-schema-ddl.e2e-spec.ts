import { PostgresConnectionService, runtimeSchemaDdlEnabled } from '../src/database/postgres-connection.service';

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

  it('allows an explicit production recovery override', async () => {
    process.env.NODE_ENV = 'production';
    process.env.RUNTIME_SCHEMA_DDL = 'true';
    const service = new PostgresConnectionService();
    const query = jest.spyOn(service, 'query').mockResolvedValue([]);

    expect(runtimeSchemaDdlEnabled()).toBe(true);
    await service.ddl('CREATE TABLE recovery_override (id integer)');
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('keeps local and test schema bootstrap behavior', () => {
    process.env.NODE_ENV = 'test';
    delete process.env.RUNTIME_SCHEMA_DDL;
    expect(runtimeSchemaDdlEnabled()).toBe(true);
  });
});
