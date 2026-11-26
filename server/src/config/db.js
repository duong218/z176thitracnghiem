/**
 * Quản lý kết nối Cơ sở dữ liệu SQL Server.
 */

import { sqlPool, closeSqlPool } from '../db/sql-server.js';

// Khởi tạo kết nối tới SQL Server
export async function connectDatabase() {
  await sqlPool();
  console.info('[db] Connected to SQL Server database successfully');
}

// Ngắt kết nối SQL Server (dùng khi shutdown server hoặc chạy test/script)
export async function disconnectDatabase() {
  await closeSqlPool();
  console.info('[db] Closed SQL Server connection');
}
