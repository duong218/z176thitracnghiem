/**
 * Kết nối SQL Server (dùng cho các phần đã chuyển khỏi MongoDB).
 */

import sql from 'mssql';
import { randomBytes } from 'node:crypto';
import { env } from './env.js';

let pool;

export async function connectSql() {
  pool = await new sql.ConnectionPool({
    server: env.sql.server,
    port: env.sql.port,
    database: env.sql.database,
    user: env.sql.user,
    password: env.sql.password,
    options: { trustServerCertificate: env.sql.trustServerCertificate },
  }).connect();
}

export async function disconnectSql() {
  await pool?.close();
}

// Chạy câu lệnh có tham số (@ten), trả về mảng dòng. Luôn truyền giá trị qua params, không nối chuỗi.
export async function query(text, params = {}) {
  const request = pool.request();
  for (const [name, value] of Object.entries(params)) request.input(name, value ?? null);
  const result = await request.query(text);
  return result.recordset ?? [];
}

// Id 24 ký tự hex, cùng định dạng ObjectId cũ
export const newId = () => randomBytes(12).toString('hex');
