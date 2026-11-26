/**
 * Service Xác thực & Quản lý Phiên Người dùng (Authentication & Session Service).
 * Xử lý ký/xác minh JWT Token, đăng nhập bảo mật, chống tấn công brute-force và cơ chế đơn phiên (Single Active Session).
 */

import bcrypt from 'bcrypt'; // MỚI — bản native (chạy ở thread pool, không chặn event loop như bcryptjs); đã dùng sẵn ở user.service.js
import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';
import { query } from '../db/sql-helpers.js';
import { ApiError, assertFound } from '../utils/api-error.js';

const REFRESH_COOKIE = 'refreshToken';

// Payload user trả về client (login/refresh/me). Kèm họ tên + mã NV từ hồ sơ Employees (nếu có;
// admin/examiner/leader chưa có hồ sơ thì để chuỗi rỗng) để giao diện hiển thị "Họ tên - Mã NV".
async function buildUserPayload(user, role) {
  // Lỗi khi tra hồ sơ không được làm hỏng đăng nhập/refresh/me: trả chuỗi rỗng, client tự dùng username.
  const { recordset: [emp] = [] } = await query(
    'SELECT fullname, employeeCode FROM employees WHERE user_id = @id',
    { id: user.id },
  ).catch(() => []);
  return {
    id: user.id,
    username: user.username,
    fullname: emp?.fullname ?? '',
    employeeCode: emp?.employeeCode ?? '',
    roleCode: role?.code,
    roleName: role?.name,
    mustChangePassword: user.mustChangePassword,
  };
}

// Đọc tài khoản kèm vai trò theo id hoặc username
export async function findUserWithRole({ id, username }) {
  const { recordset: [user] = [] } = await query(
    `SELECT u.id, u.username, u.password_hash AS passwordHash, u.role_id AS roleId, u.must_change_password AS mustChangePassword, u.is_active AS isActive,
            u.lock_until AS lockUntil, u.token_version AS tokenVersion,
            r.code AS roleCode, r.name AS roleName, r.is_active AS roleActive
       FROM users u JOIN roles r ON r.id = u.role_id
      WHERE ${id ? 'u.id = @value' : 'u.username = @value'}`,
    { value: id ?? username },
  );
  return user;
}

const roleOf = (user) => ({ code: user.roleCode, name: user.roleName, isActive: user.roleActive });

// Tăng tokenVersion để vô hiệu hóa tất cả token đã cấp trước đó, trả về giá trị mới
async function bumpTokenVersion(userId) {
  const { recordset: [row] = [] } = await query(
    `UPDATE users SET token_version = token_version + 1, updated_at = SYSUTCDATETIME()
     OUTPUT inserted.token_version AS tokenVersion WHERE id = @id`,
    { id: userId },
  );
  return row?.tokenVersion;
}

// MỚI — Dựng hồ sơ từ req.auth do middleware authenticate đã xác thực (isActive + tokenVersion + vai trò),
// tránh đọc lại User/Role lần thứ 2 ở GET /auth/me (client gọi định kỳ mỗi 5 giây).
export async function getProfileFromAuth(auth) {
  return buildUserPayload(
    { id: auth.userId, username: auth.username, mustChangePassword: auth.mustChangePassword },
    { code: auth.roleCode, name: auth.roleName },
  );
}

// Cấu hình Cookie an toàn cho Refresh Token. maxAge lấy từ chính hạn `exp` của token
// nên luôn khớp JWT_REFRESH_EXPIRES_IN (trước đây cookie cứng 7 ngày dù env đặt 1d).
export function refreshCookieOptions(refreshToken) {
  const exp = jwt.decode(refreshToken)?.exp;
  return {
    httpOnly: true,
    secure: env.isProduction,
    sameSite: 'lax',
    path: '/api/auth',
    maxAge: exp ? exp * 1000 - Date.now() : undefined,
  };
}

export { REFRESH_COOKIE };

// Tạo chuỗi Access Token (JWT) ngắn hạn kèm tokenVersion (tv)
function signAccessToken(user, roleCode) {
  return jwt.sign(
    {
      sub: user.id,
      roleCode,
      tv: user.tokenVersion ?? 0,
    },
    env.jwtSecret,
    { expiresIn: env.jwtAccessExpiresIn },
  );
}

// Tạo chuỗi Refresh Token (JWT) dài hạn kèm tokenVersion (tv)
function signRefreshToken(user) {
  return jwt.sign(
    {
      sub: user.id,
      tv: user.tokenVersion ?? 0,
      type: 'refresh',
    },
    env.jwtRefreshSecret,
    { expiresIn: env.jwtRefreshExpiresIn },
  );
}

// Kiểm tra xem tài khoản có đang trong thời gian bị tạm khóa vì nhập sai mật khẩu nhiều lần
function isAccountLocked(user) {
  return user.lockUntil && user.lockUntil > new Date();
}

// Ghi nhận số lần đăng nhập sai và tự động khóa tạm thời nếu vượt ngưỡng (1 câu UPDATE nên không đếm thiếu khi gửi đồng thời)
async function registerFailedLogin(user) {
  await query(
    `UPDATE users SET
       lock_until = CASE WHEN failed_login_attempts + 1 >= @max THEN @until ELSE lock_until END,
       failed_login_attempts = CASE WHEN failedLoginAttempts + 1 >= @max THEN 0 ELSE failedLoginAttempts + 1 END,
       updated_at = SYSUTCDATETIME()
     WHERE id = @id`,
    {
      id: user.id,
      max: env.accountLockMaxAttempts,
      until: new Date(Date.now() + env.accountLockMinutes * 60 * 1000),
    },
  );
}

// Xóa trạng thái đếm sai khi đăng nhập thành công
async function clearFailedLogin(user) {
  await query(
    `UPDATE users SET failed_login_attempts = 0, lock_until = NULL
     WHERE id = @id AND (failed_login_attempts > 0 OR lock_until IS NOT NULL)`,
    { id: user.id },
  );
}

// Xác thực đăng nhập bằng username/password và sinh cặp token mới (hủy phiên đăng nhập cũ trên thiết bị khác)
export async function loginWithUsernamePassword(username, password) {
  const normalized = username.trim().toLowerCase();
  const user = await findUserWithRole({ username: normalized });

  if (!user || !user.isActive) {
    throw new ApiError(401, 'Tên đăng nhập hoặc mật khẩu không đúng', 'AUTH_INVALID');
  }

  if (isAccountLocked(user)) {
    throw new ApiError(
      423,
      'Tài khoản tạm khóa do đăng nhập sai nhiều lần. Thử lại sau.',
      'AUTH_LOCKED',
    );
  }

  const role = roleOf(user);
  if (!role.isActive) {
    throw new ApiError(403, 'Vai trò không hợp lệ', 'AUTH_ROLE_INACTIVE');
  }

  const passwordOk = await bcrypt.compare(password, user.passwordHash);
  if (!passwordOk) {
    await registerFailedLogin(user);
    throw new ApiError(401, 'Tên đăng nhập hoặc mật khẩu không đúng', 'AUTH_INVALID');
  }

  await clearFailedLogin(user);

  // Tăng tokenVersion để vô hiệu hóa tất cả các token đã cấp trước đó của tài khoản này
  user.tokenVersion = await bumpTokenVersion(user.id);

  const accessToken = signAccessToken(user, role.code);
  const refreshToken = signRefreshToken(user);

  return {
    accessToken,
    refreshToken,
    user: await buildUserPayload(user, role),
  };
}

// Làm mới Access Token từ Refresh Token hợp lệ
export async function refreshAccessToken(refreshToken) {
  if (!refreshToken) {
    throw new ApiError(401, 'Phiên đăng nhập hết hạn', 'AUTH_REFRESH_MISSING');
  }

  let payload;
  try {
    payload = jwt.verify(refreshToken, env.jwtRefreshSecret);
  } catch {
    throw new ApiError(401, 'Phiên đăng nhập hết hạn', 'AUTH_REFRESH_INVALID');
  }

  if (payload.type !== 'refresh') {
    throw new ApiError(401, 'Phiên đăng nhập hết hạn', 'AUTH_REFRESH_INVALID');
  }

  const user = await findUserWithRole({ id: String(payload.sub) });
  assertFound(user, 'Người dùng không tồn tại', 'AUTH_USER_NOT_FOUND');

  if (!user.isActive) {
    throw new ApiError(403, 'Tài khoản đã bị vô hiệu', 'AUTH_INACTIVE');
  }

  if ((user.tokenVersion ?? 0) !== (payload.tv ?? 0)) {
    throw new ApiError(401, 'Phiên đăng nhập đã bị thu hồi', 'AUTH_REFRESH_REVOKED');
  }

  const role = roleOf(user);
  if (!role.isActive) {
    throw new ApiError(403, 'Vai trò không hợp lệ', 'AUTH_ROLE_INACTIVE');
  }

  const accessToken = signAccessToken(user, role.code);
  const newRefreshToken = signRefreshToken(user);

  return {
    accessToken,
    refreshToken: newRefreshToken,
    user: await buildUserPayload(user, role),
  };
}

// Đăng xuất: tăng tokenVersion để vô hiệu hóa phiên làm việc của người dùng
export async function logoutUser(userId) {
  await bumpTokenVersion(userId);
}

// Lấy thông tin tóm tắt hồ sơ người dùng đang xác thực
export async function getAuthProfile(userId) {
  const user = await findUserWithRole({ id: userId });
  assertFound(user, 'Người dùng không tồn tại', 'AUTH_USER_NOT_FOUND');
  if (!user.isActive) {
    throw new ApiError(403, 'Tài khoản đã bị vô hiệu', 'AUTH_INACTIVE');
  }
  return buildUserPayload(user, roleOf(user));
}

// Đổi mật khẩu tài khoản và thu hồi tất cả các phiên đăng nhập cũ
export async function changePassword(userId, currentPassword, newPassword) {
  const user = await findUserWithRole({ id: userId });
  assertFound(user, 'Người dùng không tồn tại', 'AUTH_USER_NOT_FOUND');

  const ok = await bcrypt.compare(currentPassword, user.passwordHash);
  if (!ok) {
    throw new ApiError(401, 'Mật khẩu hiện tại không đúng', 'AUTH_PASSWORD_WRONG');
  }

  if (newPassword.length < 8) {
    throw new ApiError(400, 'Mật khẩu mới tối thiểu 8 ký tự', 'AUTH_PASSWORD_WEAK');
  }

  await query(
    `UPDATE users SET password_hash = @hash, must_change_password = 0,
       token_version = token_version + 1, updated_at = SYSUTCDATETIME()
     WHERE id = @id`,
    { id: userId, hash: await bcrypt.hash(newPassword, env.bcryptSaltRounds) },
  );
}

// Xác thực chữ ký và thời hạn của Access Token
export function verifyAccessToken(token) {
  try {
    return jwt.verify(token, env.jwtSecret);
  } catch (err) {
    if (err?.name === 'TokenExpiredError') {
      throw new ApiError(401, 'Phiên đăng nhập đã hết hạn', 'AUTH_ACCESS_EXPIRED');
    }
    throw new ApiError(401, 'Phiên không hợp lệ', 'AUTH_ACCESS_INVALID');
  }
}