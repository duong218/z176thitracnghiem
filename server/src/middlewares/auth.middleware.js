/**
 * Middleware xử lý Xác thực (Authentication) & Phân quyền (Authorization).
 * Đảm bảo request có token hợp lệ, kiểm tra trạng thái hoạt động của tài khoản và quyền hạn theo vai trò (Role).
 */

import { verifyAccessToken, getAuthProfile, findUserWithRole } from '../services/auth.service.js';
import { ApiError } from '../utils/api-error.js';

// Hàm phụ trợ tách Bearer Token từ header Authorization
function extractBearerToken(req) {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    return undefined;
  }
  return header.slice(7).trim();
}

// Middleware xác thực Access Token: giải mã JWT, kiểm tra tài khoản còn hoạt động và tokenVersion hợp lệ
export async function authenticate(req, _res, next) {
  try {
    const token = extractBearerToken(req);
    if (!token) {
      throw new ApiError(401, 'Yêu cầu đăng nhập', 'AUTH_REQUIRED');
    }

    const payload = verifyAccessToken(token);
    // Đọc tài khoản + vai trò bằng 1 câu JOIN ở mỗi request để thu hồi phiên có hiệu lực tức thì
    const user = await findUserWithRole({ id: String(payload.sub) });
    if (!user || !user.isActive) {
      throw new ApiError(401, 'Phiên không hợp lệ', 'AUTH_ACCESS_INVALID');
    }
    if (user.tokenVersion !== (payload.tv ?? 0)) {
      // Token cũ mang vai trò khác vai trò hiện tại -> admin vừa đổi vai trò (khác với đăng nhập nơi khác / đổi mật khẩu)
      if (payload.roleCode && payload.roleCode !== user.roleCode) {
        throw new ApiError(401, 'Quản trị viên đã thay đổi quyền của bạn', 'AUTH_ROLE_CHANGED');
      }
      throw new ApiError(401, 'Phiên đã bị thu hồi', 'AUTH_ACCESS_REVOKED');
    }

    if (!user.roleActive) {
      throw new ApiError(403, 'Vai trò không hợp lệ', 'AUTH_ROLE_INACTIVE');
    }

    // Đính kèm thông tin danh tính người dùng vào đối tượng req.auth
    req.auth = {
      userId: user.id,
      username: user.username,
      roleId: user.roleId,
      roleCode: user.roleCode,
      roleName: user.roleName,
      mustChangePassword: user.mustChangePassword,
    };

    next();
  } catch (err) {
    next(err);
  }
}

// Middleware phân quyền: chỉ cho phép các Role có mã code trong danh sách được phép truy cập
export function requireRoleCodes(...allowedCodes) {
  const allowed = new Set(allowedCodes.map((c) => c.toLowerCase()));
  return (req, _res, next) => {
    if (!req.auth?.roleCode) {
      next(new ApiError(401, 'Yêu cầu đăng nhập', 'AUTH_REQUIRED'));
      return;
    }
    if (!allowed.has(req.auth.roleCode.toLowerCase())) {
      next(new ApiError(403, 'Không có quyền truy cập', 'AUTH_FORBIDDEN'));
      return;
    }
    next();
  };
}

// Middleware tùy chọn gắn thông tin hồ sơ nhân viên đầy đủ vào req.auth.profile nếu đã xác thực
export async function attachProfileIfAuthenticated(req, _res, next) {
  if (!req.auth?.userId) {
    next();
    return;
  }
  try {
    req.auth.profile = await getAuthProfile(req.auth.userId);
  } catch {
    /* optional profile fetch fallback */
  }
  next();
}