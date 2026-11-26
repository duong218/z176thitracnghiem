/**
 * Service Nhật ký Kiểm toán & Bảo mật (Audit Log Service) - Triển khai SQL Server.
 * Lưu vết hành động của người dùng và hỗ trợ truy vấn, tìm kiếm thông tin kiểm toán kèm hồ sơ nhân viên.
 */

import { query } from '../db/sql-helpers.js';

export const auditService = {
  // Ghi nhật ký thao tác
  async writeAudit({ actorUserId, action, resourceType, resourceId, metadata, ipAddress }) {
    try {
      const metaStr = metadata ? (typeof metadata === 'string' ? metadata : JSON.stringify(metadata)) : null;
      await query(
        `INSERT INTO audit_logs (actor_user_id, action, resource_type, resource_id, metadata, ip_address)
         VALUES (@actorUserId, @action, @resourceType, @resourceId, @metadata, @ipAddress)`,
        {
          actorUserId: actorUserId || null,
          action: action || 'UNKNOWN',
          resourceType: resourceType || 'System',
          resourceId: resourceId || null,
          metadata: metaStr,
          ipAddress: ipAddress || null,
        }
      );
    } catch (err) {
      // Ghi log thất bại không được làm hỏng luồng chính
      console.error('[audit] failed to write log:', err.message);
    }
  },

  // Truy vấn danh sách nhật ký kiểm toán
  async getAuditLogs(filters = {}) {
    const { page = 1, limit = 20, action, resourceType, from, to, q } = filters;
    const numericPage = Number(page) || 1;
    const numericLimit = Number(limit) || 20;
    const offset = (numericPage - 1) * numericLimit;

    let whereClause = 'WHERE 1=1';
    const params = { limit: numericLimit, offset };

    if (action) {
      const actions = String(action).split(',').map((a) => a.trim()).filter(Boolean);
      if (actions.length === 1) {
        whereClause += ' AND a.action = @action';
        params.action = actions[0];
      } else if (actions.length > 1) {
        const actionClauses = actions.map((act, idx) => {
          params[`act_${idx}`] = act;
          return `@act_${idx}`;
        });
        whereClause += ` AND a.action IN (${actionClauses.join(',')})`;
      }
    }

    if (resourceType) {
      whereClause += ' AND a.resource_type = @resourceType';
      params.resourceType = resourceType;
    }

    if (from) {
      whereClause += ' AND a.created_at >= @fromDate';
      params.fromDate = new Date(from);
    }

    if (to) {
      const toDate = new Date(to);
      toDate.setHours(23, 59, 59, 999);
      whereClause += ' AND a.created_at <= @toDate';
      params.toDate = toDate;
    }

    if (q && q.trim()) {
      whereClause += ` AND (
        e.fullname LIKE @queryPattern 
        OR e.employee_code LIKE @queryPattern 
        OR d.name LIKE @queryPattern
        OR u.username LIKE @queryPattern
      )`;
      params.queryPattern = `%${q.trim()}%`;
    }

    const countQuery = `
      SELECT COUNT(1) AS total
      FROM audit_logs a
      LEFT JOIN users u ON a.actor_user_id = u.id
      LEFT JOIN employees e ON e.user_id = u.id
      LEFT JOIN departments d ON e.department_id = d.id
      ${whereClause}
    `;
    const countRes = await query(countQuery, params);
    const total = countRes.recordset[0]?.total ?? 0;

    const dataQuery = `
      SELECT a.id, a.actor_user_id, a.action, a.resource_type, a.resource_id, a.metadata, a.ip_address, a.created_at,
             u.username, r.code AS role_code,
             e.fullname, e.employee_code, d.name AS department_name
      FROM audit_logs a
      LEFT JOIN users u ON a.actor_user_id = u.id
      LEFT JOIN roles r ON u.role_id = r.id
      LEFT JOIN employees e ON e.user_id = u.id
      LEFT JOIN departments d ON e.department_id = d.id
      ${whereClause}
      ORDER BY a.created_at DESC
      OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY
    `;
    const dataRes = await query(dataQuery, params);

    const items = dataRes.recordset.map((r) => {
      let meta = null;
      if (r.metadata) {
        try { meta = JSON.parse(r.metadata); } catch { meta = r.metadata; }
      }
      return {
        _id: String(r.id),
        id: String(r.id),
        action: r.action,
        resourceType: r.resource_type,
        resourceId: r.resource_id ? String(r.resource_id) : null,
        metadata: meta,
        ipAddress: r.ip_address,
        createdAt: r.created_at,
        actorUserId: r.actor_user_id ? {
          _id: String(r.actor_user_id),
          username: r.username,
          roleCode: r.role_code,
          fullname: r.fullname || null,
          employeeCode: r.employee_code || null,
          departmentName: r.department_name || null,
        } : null,
      };
    });

    return {
      items,
      pagination: {
        total,
        page: numericPage,
        limit: numericLimit,
        totalPages: Math.ceil(total / numericLimit),
      },
    };
  },
};

export async function writeAudit(params) {
  return auditService.writeAudit(params);
}
