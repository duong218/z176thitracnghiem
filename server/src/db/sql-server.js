import sql from 'mssql';
import { env, assertSqlServerEnv } from '../config/env.js';

let pool;

function config(database = env.sqlServer.database) {
  assertSqlServerEnv();
  return {
    server: env.sqlServer.host,
    port: env.sqlServer.port,
    database,
    user: env.sqlServer.user,
    password: env.sqlServer.password,
    options: {
      encrypt: env.sqlServer.encrypt,
      trustServerCertificate: env.sqlServer.trustServerCertificate,
    },
    pool: { max: 20, min: 0, idleTimeoutMillis: 30_000 },
  };
}

export async function sqlPool() {
  if (!pool) pool = await sql.connect(config());
  return pool;
}

export async function closeSqlPool() {
  if (pool) await pool.close();
  pool = undefined;
}

export async function createSqlDatabaseIfMissing() {
  const master = await new sql.ConnectionPool(config('master')).connect();
  try {
    // Database names cannot be parameterised. Restricting them to this small
    // identifier grammar prevents SQL injection in this administrative path.
    const name = env.sqlServer.database;
    if (!/^[A-Za-z][A-Za-z0-9_]{0,127}$/.test(name)) {
      throw new Error('SQL_SERVER_DATABASE must contain only letters, numbers, and underscores');
    }
    const escapedName = name.replace(/]/g, ']]');
    await master.request().query(
      `IF DB_ID(N'${escapedName}') IS NULL EXEC(N'CREATE DATABASE [${escapedName}]')`,
    );
  } finally {
    await master.close();
  }
}

export { sql };
