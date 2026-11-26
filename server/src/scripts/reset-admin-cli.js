/**
 * Script CLI: Đặt lại mật khẩu tài khoản Quản trị viên (Admin)
 * Sử dụng khi Admin quên mật khẩu hoặc bị khóa tài khoản do nhập sai nhiều lần.
 *
 * Cách dùng:
 *   node src/scripts/reset-admin-cli.js [mật_khẩu_mới] [tên_đăng_nhập_admin]
 *   hoặc:
 *   npm run reset-admin [mật_khẩu_mới]
 */

import bcrypt from 'bcryptjs';
import { connectDatabase, disconnectDatabase } from '../config/db.js';
import { assertRuntimeEnv, env } from '../config/env.js';
import { query } from '../db/sql-helpers.js';

async function main() {
  assertRuntimeEnv();
  await connectDatabase();

  // 1. Xác định mật khẩu mới cần đặt
  const customPassword = process.argv[2]?.trim();
  const targetPassword = customPassword || env.adminSeedPassword || '123456';

  // 2. Xác định tài khoản admin cần reset
  const customUsername = process.argv[3]?.trim()?.toLowerCase();
  const configuredUsername = env.adminSeedEmail?.trim()?.toLowerCase();

  let adminUser = null;

  // Tìm role admin trước
  const { recordset: roleRows } = await query("SELECT id FROM roles WHERE code = 'admin'");
  if (roleRows.length === 0) {
    // eslint-disable-next-line no-console
    console.error('❌ Lỗi: Không tìm thấy vai trò "admin" trong cơ sở dữ liệu!');
    await disconnectDatabase();
    process.exit(1);
  }
  const adminRoleId = roleRows[0].id;

  // Ưu tiên tìm theo username cụ thể (nếu có truyền vào hoặc cấu hình trong .env)
  const candidateUsername = customUsername || configuredUsername;
  if (candidateUsername) {
    const { recordset: userRows } = await query('SELECT * FROM users WHERE username = @username', { username: candidateUsername });
    if (userRows.length > 0) adminUser = userRows[0];
  }

  // Nếu không tìm thấy hoặc không có username cấu hình, tìm tài khoản đầu tiên có role là admin
  if (!adminUser) {
    const { recordset: userRows } = await query('SELECT TOP 1 * FROM users WHERE role_id = @roleId ORDER BY created_at ASC', { roleId: adminRoleId });
    if (userRows.length > 0) adminUser = userRows[0];
  }

  if (!adminUser) {
    // eslint-disable-next-line no-console
    console.warn('⚠️ Không tìm thấy tài khoản admin hiện có. Đang tạo tài khoản admin mới...');
    const usernameToCreate = candidateUsername || 'admin';
    const passwordHash = await bcrypt.hash(targetPassword, env.bcryptSaltRounds);

    const { recordset: inserted } = await query(`
      INSERT INTO users (username, password_hash, role_id, is_active, must_change_password, failed_login_attempts, lock_until, token_version)
      OUTPUT INSERTED.*
      VALUES (@username, @passwordHash, @roleId, 1, 0, 0, NULL, 1)
    `, {
      username: usernameToCreate,
      passwordHash,
      roleId: adminRoleId,
    });
    adminUser = inserted[0];

    // eslint-disable-next-line no-console
    console.info(`✅ Đã khởi tạo thành công tài khoản Admin mới:`);
    // eslint-disable-next-line no-console
    console.info(`   👉 Tên đăng nhập: ${adminUser.username}`);
    // eslint-disable-next-line no-console
    console.info(`   👉 Mật khẩu mới : ${targetPassword}`);
    await disconnectDatabase();
    return;
  }

  // 3. Tiến hành đặt lại mật khẩu và gỡ toàn bộ trạng thái khóa
  const passwordHash = await bcrypt.hash(targetPassword, env.bcryptSaltRounds);

  await query(`
    UPDATE users
    SET password_hash = @passwordHash,
        is_active = 1,
        failed_login_attempts = 0,
        lock_until = NULL,
        locked_at = NULL,
        must_change_password = 0,
        token_version = token_version + 1,
        updated_at = SYSUTCDATETIME()
    WHERE id = @id
  `, {
    id: adminUser.id,
    passwordHash,
  });

  // eslint-disable-next-line no-console
  console.info('========================================================');
  // eslint-disable-next-line no-console
  console.info('🎉 ĐẶT LẠI MẬT KHẨU TÀI KHOẢN ADMIN THÀNH CÔNG!');
  // eslint-disable-next-line no-console
  console.info(`   👉 Tên đăng nhập: ${adminUser.username}`);
  // eslint-disable-next-line no-console
  console.info(`   👉 Mật khẩu mới : ${targetPassword}`);
  // eslint-disable-next-line no-console
  console.info(`   👉 Trạng thái   : Đã mở khóa (isActive = true), gỡ bỏ giới hạn khóa tạm thời.`);
  // eslint-disable-next-line no-console
  console.info('========================================================');

  await disconnectDatabase();
}

main().catch(async (err) => {
  // eslint-disable-next-line no-console
  console.error('❌ Lỗi khi reset mật khẩu admin:', err.message);
  await disconnectDatabase().catch(() => {});
  process.exit(1);
});
