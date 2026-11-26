import bcrypt from 'bcryptjs';
import { assertSqlServerEnv, env } from '../config/env.js';
import { closeSqlPool, sql, sqlPool } from '../db/sql-server.js';

const roles = [
  ['admin', 'Quản trị hệ thống', 'Quản lý tài khoản, phân quyền, backup'],
  ['examiner', 'Người ra đề', 'Ngân hàng câu hỏi, sinh mã đề, quản lý kỳ thi'],
  ['candidate', 'Người dự thi', 'Làm bài thi, xem kết quả được phép'],
  ['leader', 'Người duyệt đề', 'Phê duyệt đề/kỳ thi'],
];

async function main() {
  assertSqlServerEnv();
  const pool = await sqlPool();
  for (const [code, name, description] of roles) {
    await pool.request()
      .input('code', sql.NVarChar(32), code)
      .input('name', sql.NVarChar(255), name)
      .input('description', sql.NVarChar(sql.MAX), description)
      .query(`IF NOT EXISTS (SELECT 1 FROM roles WHERE code = @code)
              INSERT INTO roles (code, name, description) VALUES (@code, @name, @description)`);
  }
  if (!env.adminSeedEmail || !env.adminSeedPassword) {
    console.warn('[sql] Roles seeded; admin skipped because ADMIN_SEED_EMAIL/PASSWORD is not set.');
    return;
  }
  const username = env.adminSeedEmail.trim().toLowerCase();
  const passwordHash = await bcrypt.hash(env.adminSeedPassword, env.bcryptSaltRounds);
  await pool.request()
    .input('username', sql.NVarChar(255), username)
    .input('passwordHash', sql.NVarChar(255), passwordHash)
    .input('mustChangePassword', sql.Bit, env.adminSeedMustChangePassword)
    .query(`IF NOT EXISTS (SELECT 1 FROM users WHERE username = @username)
            INSERT INTO users (username, password_hash, role_id, must_change_password)
            SELECT @username, @passwordHash, id, @mustChangePassword FROM roles WHERE code = 'admin'`);
  console.info(`[sql] Seed complete for ${pool.config.database}.`);
}

main().catch((error) => {
  console.error('[sql] seed failed:', error.message);
  process.exitCode = 1;
}).finally(closeSqlPool);
