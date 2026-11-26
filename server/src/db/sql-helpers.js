/**
 * Trợ giúp truy vấn SQL Server (SQL Server query helpers & transaction wrappers).
 * Hỗ trợ chuyển đổi tự động camelCase <-> snake_case, parameterized queries an toàn,
 * và quản lý Transaction cho các tác vụ ghi dữ liệu đa bảng.
 */

import { sql, sqlPool } from './sql-server.js';

// Chuyển snake_case sang camelCase (ví dụ: created_at -> createdAt, role_id -> roleId)
export function toCamel(str) {
  return str.replace(/_([a-z0-9])/g, (_, letter) => letter.toUpperCase());
}

// Chuyển camelCase sang snake_case (ví dụ: roleId -> role_id)
export function toSnake(str) {
  return str.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}

// Chuyển 1 dòng record SQL sang object theo quy ước model cũ (hỗ trợ ._id và .id)
export function mapRow(row) {
  if (!row) return null;
  const out = {};
  for (const [key, val] of Object.entries(row)) {
    const camel = toCamel(key);
    out[camel] = val;
  }
  // Giữ tương thích với Mongoose ODM: các service/controller/client thường đọc item._id hoặc item.id
  if (out.id && !out._id) {
    out._id = String(out.id);
  }
  return out;
}

// Chuyển mảng kết quả sang danh sách object camelCase
export function mapRows(rows) {
  if (!rows || !Array.isArray(rows)) return [];
  return rows.map(mapRow);
}

// Thực thi truy vấn đọc/ghi đơn lẻ có tham số
export async function query(text, params = {}) {
  const pool = await sqlPool();
  const req = pool.request();
  for (const [key, val] of Object.entries(params)) {
    req.input(key, val);
  }
  return req.query(text);
}

// Thực thi khối logic trong một SQL Transaction (tự động Commit/Rollback)
export async function withTransaction(callback) {
  const pool = await sqlPool();
  const tx = new sql.Transaction(pool);
  await tx.begin();
  try {
    const txQuery = async (text, params = {}) => {
      const req = new sql.Request(tx);
      for (const [key, val] of Object.entries(params)) {
        req.input(key, val);
      }
      return req.query(text);
    };
    const result = await callback(txQuery, tx);
    await tx.commit();
    return result;
  } catch (err) {
    await tx.rollback().catch(() => {}); // không để lỗi rollback che mất lỗi gốc
    throw err;
  }
}

export { sql };
