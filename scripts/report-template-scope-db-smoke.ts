import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { loadLocalEnv } from '../src/config/load-env';
import { directDatabaseUrl } from '../src/database/database-url';
import { resolvePgSsl } from '../src/database/pg-ssl';

loadLocalEnv();
const url = directDatabaseUrl();
if (!url) throw new Error('A direct database URL is required for report template scope DB smoke');

type ActorRow = { id: number };
type InstructorRow = { user_id: number };
type TemplateRow = {
  id: number;
  name: string;
  progress_page: string | null;
  homework: string | null;
  owner_user_id: number | null;
  is_default: boolean;
  is_enforced: boolean;
  deleted_at: Date | string | null;
};

function dataSource(): DataSource {
  return new DataSource({
    type: 'postgres',
    url,
    synchronize: false,
    migrationsRun: false,
    logging: false,
    entities: [],
    migrations: [],
    ssl: resolvePgSsl(),
    extra: {
      max: 1,
      connectionTimeoutMillis: Number(process.env.DB_CONNECT_TIMEOUT_MS ?? 5000),
      statement_timeout: Number(process.env.DB_STATEMENT_TIMEOUT_MS ?? 15000),
    },
  });
}

async function main(): Promise<void> {
  const stamp = Date.now();
  const name = `scope-restart-smoke-${stamp}`;
  let templateId = 0;
  let actorId = 0;
  let instructorId = 0;

  try {
    {
      const db = dataSource();
      await db.initialize();
      const [actor] = await db.query(
        `SELECT id
           FROM users
          WHERE deleted_at IS NULL
            AND status = 'active'
            AND role IN ('manager', 'admin', 'super_admin')
          ORDER BY CASE role WHEN 'manager' THEN 1 WHEN 'admin' THEN 2 ELSE 3 END, id
          LIMIT 1`,
      ) as ActorRow[];
      const [instructor] = await db.query(
        `SELECT ip.user_id
           FROM instructor_profiles ip
           JOIN users u ON u.id = ip.user_id
          WHERE ip.active = true
            AND ip.deleted_at IS NULL
            AND u.status = 'active'
            AND u.deleted_at IS NULL
          ORDER BY ip.user_id
          LIMIT 1`,
      ) as InstructorRow[];
      if (!actor || !instructor) throw new Error('active manager and instructor fixtures are required');
      actorId = Number(actor.id);
      instructorId = Number(instructor.user_id);
      const [created] = await db.query(
        `INSERT INTO report_templates
          (name, content, progress_page, homework, owner_user_id, is_default, is_enforced, created_by)
         VALUES ($1, $2, $3, $4, $5, false, false, $6)
         RETURNING id`,
        [name, 'DB restart scope readback', '12-15p', 'Vocab #6', instructorId, actorId],
      ) as Array<{ id: number }>;
      templateId = Number(created.id);
      await db.destroy();
    }

    {
      const db = dataSource();
      await db.initialize();
      const [row] = await db.query(
        `SELECT id, name, progress_page, homework, owner_user_id, is_default, is_enforced, deleted_at
           FROM report_templates
          WHERE id = $1 AND deleted_at IS NULL`,
        [templateId],
      ) as TemplateRow[];
      if (
        !row ||
        row.name !== name ||
        Number(row.owner_user_id) !== instructorId ||
        row.progress_page !== '12-15p' ||
        row.homework !== 'Vocab #6' ||
        row.is_default ||
        row.is_enforced
      ) {
        throw new Error(`report template scope did not survive reconnect: ${JSON.stringify(row)}`);
      }
      await db.query(
        `UPDATE report_templates
            SET deleted_at = now(), deleted_by = $1, updated_at = now()
          WHERE id = $2 AND deleted_at IS NULL`,
        [actorId, templateId],
      );
      await db.destroy();
    }

    {
      const db = dataSource();
      await db.initialize();
      const [visibility] = await db.query(
        `SELECT
           count(*) FILTER (WHERE deleted_at IS NULL)::int AS active_count,
           count(*) FILTER (WHERE deleted_at IS NOT NULL)::int AS deleted_count
           FROM report_templates WHERE id = $1`,
        [templateId],
      ) as Array<{ active_count: number; deleted_count: number }>;
      if (Number(visibility?.active_count) !== 0 || Number(visibility?.deleted_count) !== 1) {
        throw new Error(`soft-delete reconnect readback failed: ${JSON.stringify(visibility)}`);
      }
      await db.query('DELETE FROM report_templates WHERE id = $1', [templateId]);
      await db.destroy();
    }

    console.log(JSON.stringify({
      ok: true,
      templateId,
      instructorId,
      reconnectReadback: true,
      softDeleteReadback: true,
      cleanedUp: true,
    }));
  } catch (error) {
    if (templateId) {
      const cleanup = dataSource();
      await cleanup.initialize().then(() => cleanup.query('DELETE FROM report_templates WHERE id = $1', [templateId])).catch(() => undefined);
      if (cleanup.isInitialized) await cleanup.destroy().catch(() => undefined);
    }
    throw error;
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : error);
  process.exitCode = 1;
});
