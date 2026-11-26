/**
 * Service Xóa Cứng Tài khoản Khóa Lâu Ngày (Account Purge Service).
 * Đảm bảo an toàn dữ liệu: Chỉ xóa cứng tài khoản bị khóa liên tục > 6 tháng và KHÔNG có bất kỳ dấu vết lịch sử nào (chưa từng thi, chưa từng ghi audit log).
 */

import { query, withTransaction } from '../db/sql-helpers.js';
import { writeAudit } from './audit.service.js';

const PURGE_LOCK_MONTHS = 6; // Ngưỡng thời gian khóa liên tục tối thiểu (6 tháng)

// Tính toán mốc thời gian tối đa để đủ điều kiện xóa (tính lùi 6 tháng từ hiện tại)
function lockedBeforeThreshold(now = new Date()) {
  const threshold = new Date(now);
  threshold.setMonth(threshold.getMonth() - PURGE_LOCK_MONTHS);
  return threshold;
}

// Kiểm tra tài khoản có dấu vết lịch sử quan trọng cần giữ lại hay không (kỳ thi, nhật ký kiểm toán)
async function hasHistoricalFootprint(userId, employeeId) {
  if (employeeId) {
    const examCandidateCount = await query(
      'SELECT COUNT(*) as cnt FROM exam_candidates WHERE employee_id = @employeeId',
      { employeeId }
    );
    if (examCandidateCount[0]?.cnt > 0) return true;
  }
  const auditCount = await query(
    'SELECT COUNT(*) as cnt FROM audit_logs WHERE actor_user_id = @userId',
    { userId }
  );
  if (auditCount[0]?.cnt > 0) return true;
  return false;
}

// Quét toàn bộ CSDL và thực hiện xóa cứng các tài khoản thỏa mãn mọi tiêu chí an toàn
export async function purgeExpiredLockedAccounts() {
  const threshold = lockedBeforeThreshold();

  const candidates = await query(`
    SELECT u.id, u.username, e.id as employee_id
    FROM users u
    LEFT JOIN employees e ON e.user_id = u.id
    WHERE u.is_active = 0
      AND u.locked_at IS NOT NULL
      AND u.locked_at <= @threshold
  `, { threshold });

  const purgedUsernames = [];
  let skippedWithHistoryCount = 0;

  for (const user of candidates) {
    const userId = user.id;
    const employeeId = user.employee_id;
    const hasHistory = await hasHistoricalFootprint(userId, employeeId);

    if (hasHistory) {
      skippedWithHistoryCount += 1;
      continue;
    }

    await withTransaction(async ({ query: txQuery }) => {
      if (employeeId) {
        await txQuery('DELETE FROM employee_extra_departments WHERE employee_id = @employeeId', { employeeId });
        await txQuery('DELETE FROM employees WHERE id = @employeeId', { employeeId });
      }
      await txQuery('DELETE FROM users WHERE id = @userId', { userId });
    });

    purgedUsernames.push(user.username);
  }

  if (purgedUsernames.length > 0 || skippedWithHistoryCount > 0) {
    await writeAudit({
      actorUserId: null,
      action: 'ACCOUNT_PURGE_AUTO',
      resourceType: 'User',
      metadata: {
        purgedCount: purgedUsernames.length,
        purgedUsernames,
        skippedWithHistoryCount,
        lockMonths: PURGE_LOCK_MONTHS,
      },
    }).catch(() => {
      /* audit lỗi không được chặn job xóa */
    });
  }

  return {
    purgedCount: purgedUsernames.length,
    purgedUsernames,
    skippedWithHistoryCount,
  };
}

export { PURGE_LOCK_MONTHS, lockedBeforeThreshold };
