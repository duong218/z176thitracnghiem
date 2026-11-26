/**
 * Service Danh mục Vai trò & Phân quyền (Role Service) - Triển khai SQL Server.
 */

import { query, mapRows } from '../db/sql-helpers.js';

// Lấy danh sách các vai trò đang kích hoạt, sắp xếp theo thời gian tạo
export async function listRoles() {
  const result = await query(
    'SELECT id, code, name, description, is_active, created_at, updated_at FROM roles WHERE is_active = 1 ORDER BY created_at ASC'
  );
  return mapRows(result.recordset);
}
