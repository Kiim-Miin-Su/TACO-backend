export function runtimeDatabaseUrl(): string | undefined {
  return (
    process.env.RUNTIME_DATABASE_URL ||
    process.env.DATABASE_URL ||
    process.env.POSTGRES_URL ||
    process.env.POSTGRES_PRISMA_URL
  );
}

export function directDatabaseUrl(): string | undefined {
  return (
    process.env.DATABASE_URL_UNPOOLED ||
    process.env.POSTGRES_URL_NON_POOLING ||
    process.env.POSTGRES_URL_NO_SSL ||
    runtimeDatabaseUrl()
  );
}

export function runtimeRoleConnectionBaseUrl(): string | undefined {
  return (
    process.env.RUNTIME_ROLE_CONNECTION_BASE_URL ||
    process.env.DATABASE_URL ||
    process.env.POSTGRES_URL ||
    process.env.POSTGRES_PRISMA_URL ||
    directDatabaseUrl()
  );
}

function parsePostgresUrl(value: string, label: string): URL {
  const url = new URL(value);
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
    throw new Error(`${label}은 PostgreSQL URL이어야 합니다.`);
  }
  return url;
}

export function buildRuntimeRoleUrl(
  ownerUrl: string,
  connectionBaseUrl: string,
  role: string,
  password: string,
): string {
  const owner = parsePostgresUrl(ownerUrl, 'owner URL');
  const runtime = parsePostgresUrl(connectionBaseUrl, 'runtime connection base URL');
  if (owner.pathname !== runtime.pathname) {
    throw new Error('owner URL과 runtime connection base URL의 database가 다릅니다.');
  }

  runtime.username = role;
  runtime.password = password;
  const sslMode = runtime.searchParams.get('sslmode')?.toLowerCase();
  if (sslMode && ['prefer', 'require', 'verify-ca'].includes(sslMode)) {
    runtime.searchParams.set('sslmode', 'verify-full');
  }
  return runtime.toString();
}
