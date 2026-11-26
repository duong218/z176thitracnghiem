import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { closeSqlPool, createSqlDatabaseIfMissing, sqlPool } from '../db/sql-server.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const schemaPath = path.resolve(here, '../../sql/schema.sql');

async function main() {
  await createSqlDatabaseIfMissing();
  const schema = await fs.readFile(schemaPath, 'utf8');
  const pool = await sqlPool();
  for (const batch of schema.split(/^\s*GO\s*$/gim)) {
    if (batch.trim()) await pool.request().batch(batch);
  }
  console.info(`[sql] Database "${pool.config.database}" is ready.`);
}

main().catch((error) => {
  console.error('[sql] init failed:', error.message);
  process.exitCode = 1;
}).finally(closeSqlPool);
