/**
 * Service Khởi tạo Dữ liệu Mặc định (Seed Data Service).
 * Tự động tạo các vai trò mặc định (admin, examiner, candidate, leader) và tài khoản Quản trị viên (Admin) lúc khởi động.
 */

import bcrypt from 'bcryptjs';
import { env } from '../config/env.js';
import { query } from '../db/sql-helpers.js';

// Danh sách các vai trò mặc định của hệ thống
const DEFAULT_ROLES = [
  {
    code: 'admin',
    name: 'Quản trị hệ thống',
    description: 'Quản lý tài khoản, phân quyền, backup',
  },
  {
    code: 'examiner',
    name: 'Người ra đề',
    description: 'Ngân hàng câu hỏi, sinh mã đề, quản lý kỳ thi',
  },
  {
    code: 'candidate',
    name: 'Người dự thi',
    description: 'Làm bài thi, xem kết quả được phép',
  },
  {
    code: 'leader',
    name: 'Người duyệt đề',
    description: 'Phê duyệt đề/kỳ thi (Should Have FR-006)',
  },
];

// Khởi tạo danh sách các vai trò nếu chưa tồn tại trong CSDL
export async function seedRolesIfEmpty() {
  for (const role of DEFAULT_ROLES) {
    await query(
      `IF NOT EXISTS (SELECT 1 FROM roles WHERE code = @code)
         INSERT INTO roles (code, name, description) VALUES (@code, @name, @description)`,
      role,
    );
  }
}

// Khởi tạo tài khoản Quản trị viên mặc định theo cấu hình biến môi trường
export async function seedAdminIfConfigured() {
  if (!env.adminSeedEmail || !env.adminSeedPassword) {
    return { seeded: false, reason: 'ADMIN_SEED_EMAIL/PASSWORD not set' };
  }

  const roleRes = await query("SELECT id FROM roles WHERE code = 'admin'");
  const adminRole = roleRes.recordset?.[0];
  if (!adminRole) {
    return { seeded: false, reason: 'admin role missing' };
  }

  const username = env.adminSeedEmail.trim().toLowerCase();
  const existingRes = await query('SELECT id FROM users WHERE username = @username', { username });
  const existing = existingRes.recordset?.[0];
  if (existing) {
    return { seeded: false, reason: 'admin user already exists' };
  }

  const passwordHash = await bcrypt.hash(env.adminSeedPassword, env.bcryptSaltRounds);
  await query(
    `INSERT INTO users (username, password_hash, role_id, must_change_password, is_active, token_version)
     VALUES (@username, @passwordHash, @roleId, @mustChange, 1, 1)`,
    { username, passwordHash, roleId: adminRole.id, mustChange: env.adminSeedMustChangePassword ? 1 : 0 },
  );

  return {
    seeded: true,
    username,
    mustChangePassword: env.adminSeedMustChangePassword,
  };
}

// Điều phối toàn bộ quy trình Seed dữ liệu ban đầu
export async function runStartupSeed({ includeAdmin = true } = {}) {
  await seedRolesIfEmpty();
  const adminResult = includeAdmin
    ? await seedAdminIfConfigured()
    : { seeded: false, reason: 'skipped' };
  return { rolesSeeded: true, adminResult };
}