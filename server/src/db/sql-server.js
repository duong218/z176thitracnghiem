import sql from 'mssql';
import { env, assertSqlServerEnv } from '../config/env.js';

let pool;
let maintenance = false;

// Bật trong lúc RESTORE: không cho request/cron mở lại kết nối (sẽ chiếm mất chế độ SINGLE_USER)
export function setDbMaintenance(value) {
  maintenance = value;
}

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

// Kết nối riêng tới master cho BACKUP/RESTORE: lệnh có thể chạy lâu hơn timeout mặc định 15 giây
export async function openAdminPool() {
  return new sql.ConnectionPool({ ...config('master'), requestTimeout: 60 * 60 * 1000 }).connect();
}

export async function sqlPool() {
  if (maintenance) {
    throw Object.assign(new Error('Hệ thống đang khôi phục dữ liệu, vui lòng thử lại sau.'), {
      statusCode: 503,
      code: 'DB_MAINTENANCE',
    });
  }
  if (!pool) {
    pool = await sql.connect(config());
    pool.on('error', (err) => console.error('[db] pool error:', err.message)); // thiếu listener thì lỗi kết nối làm sập Node
  }
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
