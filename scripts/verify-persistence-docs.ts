import 'reflect-metadata';
import { resolvePgSsl } from '../src/database/pg-ssl';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { DataSource } from 'typeorm';
import { loadLocalEnv } from '../src/config/load-env';
import { directDatabaseUrl } from '../src/database/database-url';

loadLocalEnv();

type ColumnRow = {
  table_name: string;
  column_name: string;
  ordinal_position: number;
  data_type: string;
  udt_name: string;
  character_maximum_length: number | null;
  is_nullable: 'YES' | 'NO';
};

const backendRoot = resolve(__dirname, '..');
const docsRoot = resolve(backendRoot, '..', 'docs');
const dictionaryPath = resolve(docsRoot, 'DATA_DICTIONARY.md');
const dbmlPath = resolve(docsRoot, 'erd.dbml');
const columnMapPath = resolve(docsRoot, 'PERSISTENCE-COLUMNS.md');

const source = readFileSync(resolve(backendRoot, 'src/database/calendar-asset-specs.ts'), 'utf8');
const collectionTables = [...source.matchAll(/\btable:\s*'([a-z][a-z0-9_]*)'/g)].map((match) => match[1]);
const runtimeTables = new Set([
  ...collectionTables,
  'auth_rate_limits',
  'class_sessions',
  'instructor_profiles',
  'schedule_requests',
]);

const parseDbml = (text: string): Map<string, string[]> => {
  const tables = new Map<string, string[]>();
  for (const match of text.matchAll(/^Table\s+([a-z][a-z0-9_]*)\s*\{([\s\S]*?)^\}/gm)) {
    const columns = [...match[2].matchAll(/^\s{2}([a-z][a-z0-9_]*)\s+/gm)]
      .map((column) => column[1])
      .filter((column) => column !== 'indexes');
    tables.set(match[1], columns);
  }
  return tables;
};

const parseDocumentedColumns = (text: string): Map<string, string[]> => {
  const block = text.match(/<!-- persistence-columns:start -->([\s\S]*?)<!-- persistence-columns:end -->/);
  const tables = new Map<string, string[]>();
  if (!block) return tables;
  for (const line of block[1].split('\n')) {
    const row = line.match(/^\| `([a-z][a-z0-9_]*)` \| (.+) \|$/);
    if (!row) continue;
    tables.set(row[1], [...row[2].matchAll(/`([a-z][a-z0-9_]*)`/g)].map((column) => column[1]));
  }
  return tables;
};

const difference = (left: string[], right: string[]): string[] => left.filter((item) => !right.includes(item));

async function main(): Promise<void> {
  const url = directDatabaseUrl();
  if (!url) throw new Error('DATABASE_URL_UNPOOLED, DATABASE_URL, POSTGRES_URL_NON_POOLING, or POSTGRES_URL is required');

  const dataSource = new DataSource({
    type: 'postgres',
    url,
    synchronize: false,
    migrationsRun: false,
    logging: false,
    entities: [],
    migrations: [],
    ssl: resolvePgSsl() /* [TBO-34 C2-C] TLS 단일 진실원 — production 검증 강제 */,
    extra: { max: 1, connectionTimeoutMillis: Number(process.env.DB_CONNECT_TIMEOUT_MS ?? 5000) },
  });

  try {
    await dataSource.initialize();
    const columns = await dataSource.query(
      `SELECT c.table_name, c.column_name, c.ordinal_position, c.data_type, c.udt_name,
              c.character_maximum_length, c.is_nullable
         FROM information_schema.columns c
         JOIN information_schema.tables t
           ON t.table_schema = c.table_schema AND t.table_name = c.table_name
        WHERE c.table_schema = 'public' AND t.table_type = 'BASE TABLE'
        ORDER BY c.table_name, c.ordinal_position`,
    ) as ColumnRow[];

    const live = new Map<string, ColumnRow[]>();
    for (const column of columns) {
      const list = live.get(column.table_name) ?? [];
      list.push(column);
      live.set(column.table_name, list);
    }

    if (process.argv.includes('--print-markdown')) {
      console.log('<!-- persistence-columns:start -->');
      console.log('| 물리 테이블 | 실제 컬럼(ordinal order) |');
      console.log('|---|---|');
      for (const [table, tableColumns] of live) {
        console.log(`| \`${table}\` | ${tableColumns.map((column) => `\`${column.column_name}\``).join(', ')} |`);
      }
      console.log('<!-- persistence-columns:end -->');
      return;
    }

    const dictionary = readFileSync(dictionaryPath, 'utf8');
    const documented = parseDocumentedColumns(readFileSync(columnMapPath, 'utf8'));
    const dbml = parseDbml(readFileSync(dbmlPath, 'utf8'));
    const missingInLive = [...runtimeTables].filter((table) => !live.has(table)).sort();
    const missingDictionarySections = [...runtimeTables]
      .filter((table) => !new RegExp(`^###(?:\\s+|.*?\\s/)${table}(?:\\s|$)`, 'm').test(dictionary))
      .sort();
    const undocumentedPhysicalTables = [...live.keys()].filter((table) => !documented.has(table)).sort();
    const dbmlOnlyTables = [...dbml.keys()].filter((table) => !live.has(table)).sort();
    const columnDrift = [...live.entries()].flatMap(([table, tableColumns]) => {
      const liveNames = tableColumns.map((column) => column.column_name);
      const documentedNames = documented.get(table) ?? [];
      const dbmlNames = dbml.get(table) ?? [];
      const documentMissing = difference(liveNames, documentedNames);
      const documentExtra = difference(documentedNames, liveNames);
      const dbmlMissing = difference(liveNames, dbmlNames);
      const dbmlExtra = difference(dbmlNames, liveNames);
      return documentMissing.length || documentExtra.length || dbmlMissing.length || dbmlExtra.length
        ? [{ table, documentMissing, documentExtra, dbmlMissing, dbmlExtra }]
        : [];
    });

    const report = {
      ok: missingInLive.length === 0
        && missingDictionarySections.length === 0
        && undocumentedPhysicalTables.length === 0
        && dbmlOnlyTables.length === 0
        && columnDrift.length === 0,
      livePhysicalTables: live.size,
      runtimeDomainTables: runtimeTables.size,
      missingInLive,
      missingDictionarySections,
      undocumentedPhysicalTables,
      dbmlOnlyTables,
      columnDrift,
    };
    console.log(JSON.stringify(report, null, 2));
    if (!report.ok) process.exitCode = 1;
  } finally {
    if (dataSource.isInitialized) await dataSource.destroy();
  }
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }));
  process.exitCode = 1;
});
