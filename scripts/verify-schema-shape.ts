import 'reflect-metadata';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { DataSource } from 'typeorm';
import { loadLocalEnv } from '../src/config/load-env';
import { directDatabaseUrl } from '../src/database/database-url';
import { resolvePgSsl } from '../src/database/pg-ssl';
import { LOGICAL_RELATION_POLICIES } from '../src/database/schema-relation-policy';

loadLocalEnv();

type DbmlColumn = {
  table: string;
  name: string;
  type: string;
  notNull: boolean;
  primaryKey: boolean;
  increment: boolean;
  defaultValue: string | null;
};

type Relation = {
  sourceTable: string;
  sourceColumns: string[];
  targetTable: string;
  targetColumns: string[];
};

type ColumnRow = {
  table_name: string;
  column_name: string;
  data_type: string;
  udt_name: string;
  character_maximum_length: number | null;
  is_nullable: 'YES' | 'NO';
  column_default: string | null;
};

type ForeignKeyRow = {
  constraint_name: string;
  source_table: string;
  source_columns: string[];
  target_table: string;
  target_columns: string[];
  convalidated: boolean;
};

type ConstraintHealthRow = {
  table_name: string;
  constraint_name: string;
  constraint_type: 'c' | 'f';
  convalidated: boolean;
  definition: string;
};

type IndexHealthRow = {
  table_name: string;
  index_name: string;
  indisvalid: boolean;
  indisready: boolean;
};

const backendRoot = resolve(__dirname, '..');
const dbmlPath = resolve(backendRoot, '..', 'docs', 'erd.dbml');

const normalizeWhitespace = (value: string): string => value.replace(/\s+/g, ' ').trim();

const splitSettings = (settings: string): string[] => {
  const result: string[] = [];
  let quote: "'" | '"' | '`' | null = null;
  let start = 0;
  for (let index = 0; index < settings.length; index += 1) {
    const char = settings[index] as "'" | '"' | '`' | string;
    if (quote) {
      if (char === quote && settings[index - 1] !== '\\') quote = null;
      continue;
    }
    if (char === "'" || char === '"' || char === '`') {
      quote = char;
      continue;
    }
    if (char === ',') {
      result.push(settings.slice(start, index).trim());
      start = index + 1;
    }
  }
  result.push(settings.slice(start).trim());
  return result.filter(Boolean);
};

const relationKey = (relation: Relation): string =>
  `${relation.sourceTable}(${relation.sourceColumns.join(',')})>${relation.targetTable}(${relation.targetColumns.join(',')})`;

const extractBracketSettings = (line: string): string => {
  const open = line.indexOf('[');
  if (open < 0) return '';
  let quote: "'" | '"' | '`' | null = null;
  for (let index = open + 1; index < line.length; index += 1) {
    const char = line[index] as "'" | '"' | '`' | string;
    if (quote) {
      if (char === quote && line[index - 1] !== '\\') quote = null;
      continue;
    }
    if (char === "'" || char === '"' || char === '`') {
      quote = char;
      continue;
    }
    if (char === ']') return line.slice(open + 1, index);
  }
  return '';
};

const parseDbml = (text: string): {
  columns: DbmlColumn[];
  relations: Relation[];
  enums: Set<string>;
  unsupportedRefs: string[];
} => {
  const columns: DbmlColumn[] = [];
  const relations: Relation[] = [];
  const unsupportedRefs: string[] = [];
  const enums = new Set([...text.matchAll(/^Enum\s+([a-z][a-z0-9_]*)\s*\{/gm)].map((match) => match[1]));

  for (const tableMatch of text.matchAll(/^Table\s+([a-z][a-z0-9_]*)\s*\{([\s\S]*?)^\}/gm)) {
    const table = tableMatch[1];
    for (const line of tableMatch[2].split('\n')) {
      const column = line.match(
        /^\s{2}([a-z][a-z0-9_]*)\s+([a-z][a-z0-9_]*(?:\(\d+(?:\s*,\s*\d+)?\))?)/,
      );
      if (!column || column[1] === 'indexes') continue;
      const settings = splitSettings(extractBracketSettings(line));
      const defaultSetting = settings.find((setting) => setting.startsWith('default:'));
      columns.push({
        table,
        name: column[1],
        type: column[2].replace(/\s+/g, ''),
        notNull: settings.includes('not null') || settings.includes('pk'),
        primaryKey: settings.includes('pk'),
        increment: settings.includes('increment'),
        defaultValue: defaultSetting ? defaultSetting.slice('default:'.length).trim().replace(/^`|`$/g, '') : null,
      });
      const ref = settings.find((setting) => setting.startsWith('ref:'));
      if (ref) {
        const parsed = ref.match(/^ref:\s*[<>-]\s*([a-z][a-z0-9_]*)\.([a-z][a-z0-9_]*)$/);
        if (!parsed) unsupportedRefs.push(`${table}.${column[1]} [${ref}]`);
        else {
          relations.push({
            sourceTable: table,
            sourceColumns: [column[1]],
            targetTable: parsed[1],
            targetColumns: [parsed[2]],
          });
        }
      }
    }
  }

  for (const match of text.matchAll(/^Ref:\s*([a-z][a-z0-9_]*)\.([a-z][a-z0-9_]*)\s*[<>-]\s*([a-z][a-z0-9_]*)\.([a-z][a-z0-9_]*)/gm)) {
    relations.push({
      sourceTable: match[1],
      sourceColumns: [match[2]],
      targetTable: match[3],
      targetColumns: [match[4]],
    });
  }

  for (const line of text.match(/^Ref:.*$/gm) ?? []) {
    if (!/^Ref:\s*[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*\s*[<>-]\s*[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*/.test(line)) {
      unsupportedRefs.push(line);
    }
  }

  return {
    columns,
    relations: [...new Map(relations.map((relation) => [relationKey(relation), relation])).values()],
    enums,
    unsupportedRefs,
  };
};

const normalizeDbmlType = (type: string): string => {
  if (type === 'int') return 'integer';
  if (type === 'timestamp') return 'timestamp without time zone';
  if (type === 'timestamptz') return 'timestamp with time zone';
  const varchar = type.match(/^varchar\((\d+)\)$/);
  if (varchar) return `character varying(${varchar[1]})`;
  return type;
};

const normalizeLiveType = (column: ColumnRow): string => {
  if (column.data_type === 'character varying') return `character varying(${column.character_maximum_length ?? ''})`;
  if (column.data_type === 'USER-DEFINED') return column.udt_name;
  return column.data_type;
};

const stripTypeCasts = (value: string): string =>
  value
    .replace(/::(?:character varying|text|[a-z_][a-z0-9_]*(?:\[\])?)/gi, '')
    .replace(/^\((.*)\)$/s, '$1');

const normalizeDefault = (value: string | null): string | null => {
  if (value == null) return null;
  const normalized = stripTypeCasts(normalizeWhitespace(value).replace(/^`|`$/g, ''));
  if (/^current_timestamp$/i.test(normalized)) return 'now()';
  return normalized;
};

async function main(): Promise<void> {
  const url = directDatabaseUrl();
  if (!url) throw new Error('A direct database URL is required');
  const parsed = parseDbml(readFileSync(dbmlPath, 'utf8'));
  const dataSource = new DataSource({
    type: 'postgres',
    url,
    synchronize: false,
    migrationsRun: false,
    logging: false,
    entities: [],
    migrations: [],
    ssl: resolvePgSsl(),
    extra: { max: 1, connectionTimeoutMillis: Number(process.env.DB_CONNECT_TIMEOUT_MS ?? 5000) },
  });

  try {
    await dataSource.initialize();
    const columns = await dataSource.query(
      `SELECT c.table_name, c.column_name, c.data_type, c.udt_name,
              c.character_maximum_length, c.is_nullable, c.column_default
         FROM information_schema.columns c
         JOIN information_schema.tables t
           ON t.table_schema = c.table_schema AND t.table_name = c.table_name
        WHERE c.table_schema = 'public' AND t.table_type = 'BASE TABLE'
        ORDER BY c.table_name, c.ordinal_position`,
    ) as ColumnRow[];
    const foreignKeys = await dataSource.query(
      `SELECT con.conname AS constraint_name,
              src.relname AS source_table,
              json_agg(src_att.attname ORDER BY key_col.ordinality) AS source_columns,
              target.relname AS target_table,
              json_agg(target_att.attname ORDER BY key_col.ordinality) AS target_columns,
              con.convalidated
         FROM pg_constraint con
         JOIN pg_class src ON src.oid = con.conrelid
         JOIN pg_namespace ns ON ns.oid = src.relnamespace AND ns.nspname = 'public'
         JOIN pg_class target ON target.oid = con.confrelid
         JOIN unnest(con.conkey, con.confkey) WITH ORDINALITY
              AS key_col(src_num, target_num, ordinality) ON true
         JOIN pg_attribute src_att ON src_att.attrelid = src.oid AND src_att.attnum = key_col.src_num
         JOIN pg_attribute target_att ON target_att.attrelid = target.oid AND target_att.attnum = key_col.target_num
        WHERE con.contype = 'f'
        GROUP BY con.conname, src.relname, target.relname, con.convalidated
        ORDER BY src.relname, con.conname`,
    ) as ForeignKeyRow[];
    const constraintHealth = await dataSource.query(
      `SELECT cls.relname AS table_name, con.conname AS constraint_name,
              con.contype AS constraint_type, con.convalidated,
              pg_get_constraintdef(con.oid) AS definition
         FROM pg_constraint con
         JOIN pg_class cls ON cls.oid = con.conrelid
         JOIN pg_namespace ns ON ns.oid = cls.relnamespace
        WHERE ns.nspname = 'public' AND con.contype IN ('c', 'f')
        ORDER BY cls.relname, con.conname`,
    ) as ConstraintHealthRow[];
    const indexHealth = await dataSource.query(
      `SELECT cls.relname AS table_name, idx.relname AS index_name,
              pi.indisvalid, pi.indisready
         FROM pg_index pi
         JOIN pg_class cls ON cls.oid = pi.indrelid
         JOIN pg_class idx ON idx.oid = pi.indexrelid
         JOIN pg_namespace ns ON ns.oid = cls.relnamespace
        WHERE ns.nspname = 'public'
        ORDER BY cls.relname, idx.relname`,
    ) as IndexHealthRow[];

    const liveColumns = new Map(columns.map((column) => [`${column.table_name}.${column.column_name}`, column]));
    const validatedChecks = constraintHealth.filter((row) => row.constraint_type === 'c' && row.convalidated);
    const enumStorageMappings: Array<{ table: string; column: string; enum: string; physicalType: string }> = [];
    const shapeDrift = parsed.columns.flatMap((column) => {
      const live = liveColumns.get(`${column.table}.${column.name}`);
      if (!live) return [];
      const expectedType = normalizeDbmlType(column.type);
      const actualType = normalizeLiveType(live);
      const expectedDefault = normalizeDefault(column.defaultValue);
      const actualDefault = normalizeDefault(live.column_default);
      const logicalEnumOnVarchar = parsed.enums.has(column.type)
        && actualType.startsWith('character varying(')
        && validatedChecks.some((check) =>
          check.table_name === column.table && new RegExp(`\\b${column.name}\\b`).test(check.definition));
      if (logicalEnumOnVarchar) {
        enumStorageMappings.push({ table: column.table, column: column.name, enum: column.type, physicalType: actualType });
      }
      const typeMismatch = expectedType !== actualType && !logicalEnumOnVarchar;
      const nullMismatch = column.notNull !== (live.is_nullable === 'NO');
      const defaultMismatch = column.increment
        ? !(actualDefault?.startsWith('nextval(') ?? false)
        : expectedDefault !== actualDefault;
      return typeMismatch || nullMismatch || defaultMismatch
        ? [{
          table: column.table,
          column: column.name,
          expected: { type: expectedType, notNull: column.notNull, default: expectedDefault, increment: column.increment },
          actual: { type: actualType, notNull: live.is_nullable === 'NO', default: actualDefault },
        }]
        : [];
    });

    const dbmlRelations = new Map(parsed.relations.map((relation) => [relationKey(relation), relation]));
    const physicalRelations = new Map(foreignKeys.map((relation) => [relationKey({
      sourceTable: relation.source_table,
      sourceColumns: relation.source_columns,
      targetTable: relation.target_table,
      targetColumns: relation.target_columns,
    }), relation]));
    const policies = new Map(LOGICAL_RELATION_POLICIES.map((policy) => [relationKey(policy), policy]));
    const unclassifiedDbmlRelations = [...dbmlRelations.keys()]
      .filter((key) => !physicalRelations.has(key) && !policies.has(key))
      .sort();
    const stalePolicies = [...policies.keys()].filter((key) => !dbmlRelations.has(key)).sort();
    const physicalRelationsMissingFromDbml = [...physicalRelations.keys()]
      .filter((key) => !dbmlRelations.has(key))
      .sort();
    const invalidConstraints = constraintHealth.filter((row) => !row.convalidated);
    const invalidIndexes = indexHealth.filter((row) => !row.indisvalid || !row.indisready);

    const report = {
      ok: shapeDrift.length === 0
        && parsed.unsupportedRefs.length === 0
        && unclassifiedDbmlRelations.length === 0
        && stalePolicies.length === 0
        && physicalRelationsMissingFromDbml.length === 0
        && invalidConstraints.length === 0
        && invalidIndexes.length === 0,
      counts: {
        dbmlColumns: parsed.columns.length,
        liveColumns: columns.length,
        dbmlRelations: dbmlRelations.size,
        physicalForeignKeys: physicalRelations.size,
        logicalPolicies: policies.size,
        checksAndForeignKeys: constraintHealth.length,
        indexes: indexHealth.length,
        logicalEnumsBackedByChecks: enumStorageMappings.length,
      },
      enumStorageMappings,
      shapeDrift,
      unsupportedRefs: parsed.unsupportedRefs,
      unclassifiedDbmlRelations,
      stalePolicies,
      physicalRelationsMissingFromDbml,
      invalidConstraints,
      invalidIndexes,
    };
    const output = process.argv.includes('--summary')
      ? {
        ok: report.ok,
        counts: report.counts,
        shapeDrift: report.shapeDrift.map((drift) => ({
          column: `${drift.table}.${drift.column}`,
          expected: drift.expected,
          actual: drift.actual,
        })),
        unsupportedRefs: report.unsupportedRefs,
        unclassifiedDbmlRelations: report.unclassifiedDbmlRelations,
        stalePolicies: report.stalePolicies,
        physicalRelationsMissingFromDbml: report.physicalRelationsMissingFromDbml,
        invalidConstraints: report.invalidConstraints,
        invalidIndexes: report.invalidIndexes,
      }
      : report;
    console.log(JSON.stringify(output, null, 2));
    if (!report.ok) process.exitCode = 1;
  } finally {
    if (dataSource.isInitialized) await dataSource.destroy();
  }
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }));
  process.exitCode = 1;
});
