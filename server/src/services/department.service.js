/**
 * Service Quản lý Đơn vị / Phòng ban (Department Service) - Triển khai SQL Server.
 * Hỗ trợ chuẩn hóa tên/mã phòng ban (slug), xử lý tìm kiếm không phân biệt hoa thường/dấu và tự động khôi phục dữ liệu import.
 */

import { query, withTransaction, mapRow, mapRows } from '../db/sql-helpers.js';
import { normalizeDeptName, normalizeDeptCode } from '../utils/normalize-dept.js';
import { ApiError, assertFound } from '../utils/api-error.js';
import { planImportDepartments } from '../utils/import-departments.js';
import { EXAM_STATUS, ATTEMPT_STATUS } from '../models/constants.js';

// Lấy danh sách các đơn vị/phòng ban
export async function listDepartments({ activeOnly = true } = {}) {
  const sqlText = activeOnly
    ? 'SELECT id, name, slug, code, description, is_active, created_at, updated_at FROM departments WHERE is_active = 1 ORDER BY name ASC'
    : 'SELECT id, name, slug, code, description, is_active, created_at, updated_at FROM departments ORDER BY name ASC';
  const res = await query(sqlText);
  return mapRows(res.recordset);
}

// Tạo mới phòng ban thủ công
export async function createDepartment({ name, code, description }) {
  const trimmed = name?.trim();
  if (!trimmed) {
    throw new ApiError(400, 'Tên bộ phận là bắt buộc', 'DEPARTMENT_VALIDATION');
  }
  const trimmedCode = code ? normalizeDeptCode(code) : '';
  if (!trimmedCode) {
    throw new ApiError(400, 'Mã bộ phận là bắt buộc', 'DEPARTMENT_VALIDATION');
  }
  const slug = normalizeDeptName(trimmed);

  try {
    const res = await query(
      `INSERT INTO departments (name, slug, code, description, is_active)
       OUTPUT INSERTED.id, INSERTED.name, INSERTED.slug, INSERTED.code, INSERTED.description, INSERTED.is_active, INSERTED.created_at, INSERTED.updated_at
       VALUES (@name, @slug, @code, @description, 1)`,
      {
        name: trimmed,
        slug,
        code: trimmedCode,
        description: description?.trim() || '',
      }
    );
    return mapRow(res.recordset[0]);
  } catch (err) {
    if (err.number === 2627 || err.number === 2601) {
      throw new ApiError(409, 'Tên hoặc mã bộ phận đã tồn tại', 'DEPARTMENT_DUPLICATE');
    }
    throw err;
  }
}

// Khối xử lý Upsert phòng ban khi Import Excel (tự động khôi phục nếu tên/mã trùng với bản ghi đã xóa mềm)
export async function upsertDepartmentForImport({ name, code, description }) {
  const trimmedName = name?.trim();
  if (!trimmedName) {
    throw new ApiError(400, 'Tên bộ phận là bắt buộc', 'DEPARTMENT_VALIDATION');
  }
  const normalizedCode = code ? normalizeDeptCode(code) : undefined;
  const slug = normalizeDeptName(trimmedName);

  let deptRes = await query('SELECT * FROM departments WHERE slug = @slug', { slug });
  let dept = mapRow(deptRes.recordset[0]);

  if (!dept && normalizedCode) {
    deptRes = await query('SELECT * FROM departments WHERE code = @code', { code: normalizedCode });
    dept = mapRow(deptRes.recordset[0]);
  }

  if (!dept) {
    return createDepartment({ name: trimmedName, code, description });
  }

  if (dept.isActive) {
    return dept;
  }

  try {
    const updateRes = await query(
      `UPDATE departments 
       SET is_active = 1, name = @name, code = ISNULL(@code, code), description = ISNULL(@description, description), updated_at = SYSUTCDATETIME()
       OUTPUT INSERTED.*
       WHERE id = @id`,
      {
        id: dept.id,
        name: trimmedName,
        code: normalizedCode || null,
        description: description !== undefined ? (description?.trim() || '') : null,
      }
    );
    return mapRow(updateRes.recordset[0]);
  } catch (err) {
    if (err.number === 2627 || err.number === 2601) {
      throw new ApiError(
        409,
        `Mã bộ phận "${code}" đang được dùng cho bộ phận khác, vui lòng chọn mã khác.`,
        'DEPARTMENT_CODE_DUPLICATE',
      );
    }
    throw err;
  }
}

// Tìm phòng ban theo tên chuẩn hóa (không phân biệt hoa/thường, không dấu)
export async function findDepartmentByName(name) {
  const slug = normalizeDeptName(name);
  if (!slug) return null;

  const res = await query('SELECT * FROM departments WHERE slug = @slug AND is_active = 1', { slug });
  return mapRow(res.recordset[0]);
}

// Tìm hoặc tự động tạo phòng ban mới theo tên
export async function findOrCreateDepartmentByName(name) {
  const trimmed = name?.trim();
  if (!trimmed) return null;

  const existing = await findDepartmentByName(trimmed);
  if (existing) return existing;

  const slug = normalizeDeptName(trimmed);
  const inactiveRes = await query('SELECT * FROM departments WHERE slug = @slug AND is_active = 0', { slug });
  let inactiveMatch = mapRow(inactiveRes.recordset[0]);
  if (inactiveMatch) {
    const updated = await query(
      `UPDATE departments SET is_active = 1, name = @name, updated_at = SYSUTCDATETIME()
       OUTPUT INSERTED.* WHERE id = @id`,
      { name: trimmed, id: inactiveMatch.id }
    );
    return mapRow(updated.recordset[0]);
  }

  try {
    return await createDepartment({ name: trimmed, code: slug.toUpperCase().slice(0, 10) });
  } catch {
    const fallback = await findDepartmentByName(trimmed);
    if (fallback) return fallback;
    throw new ApiError(409, 'Không thể tạo phòng ban', 'DEPARTMENT_DUPLICATE');
  }
}

// Đánh giá điều kiện ngừng sử dụng phòng ban
export function evaluateDepartmentDeactivation(
  deptName,
  { inProgressAttempts = 0, publishedExam = null, activePrimary = 0, activeExtra = 0 } = {},
  { force = false } = {},
) {
  if (inProgressAttempts > 0) {
    return {
      code: 'DEPARTMENT_HAS_IN_PROGRESS_ATTEMPTS',
      message: `Không thể ngừng sử dụng phòng ban "${deptName}" vì đang có ${inProgressAttempts} lượt thi chưa nộp bài. Vui lòng đợi thí sinh nộp bài hoặc hết giờ thi.`,
    };
  }

  if (publishedExam) {
    return {
      code: 'DEPARTMENT_HAS_ACTIVE_EXAM',
      message: `Không thể ngừng sử dụng phòng ban "${deptName}" vì phòng ban này đang thuộc danh sách tham gia kỳ thi "${publishedExam.title}" đang diễn ra. Vui lòng đợi kỳ thi kết thúc rồi thử lại.`,
    };
  }

  if (activePrimary > 0 && force !== true) {
    return {
      code: 'DEPARTMENT_HAS_ACTIVE_EMPLOYEES',
      message: `Phòng ban "${deptName}" đang có ${activePrimary} tài khoản nhân viên hoạt động. Việc ngừng sử dụng sẽ ảnh hưởng đến phân công thi của các tài khoản này. Bạn có chắc muốn tiếp tục?`,
    };
  }

  if (activeExtra > 0 && force !== true) {
    return {
      code: 'DEPARTMENT_HAS_EXTRA_EMPLOYEES',
      message: `Phòng ban "${deptName}" đang có ${activeExtra} nhân viên kiêm nhiệm hoạt động. Việc ngừng sử dụng sẽ gỡ liên kết kiêm nhiệm này. Bạn có chắc muốn tiếp tục?`,
    };
  }

  return null;
}

// Kiểm tra toàn diện phòng ban trước khi ngừng kích hoạt (deactivate)
async function assertDepartmentDeactivatable(dept, { force = false } = {}) {
  const attemptsRes = await query(
    `SELECT COUNT(1) AS count FROM exam_attempts 
     WHERE department_id = @deptId AND status = @status`,
    { deptId: dept.id, status: ATTEMPT_STATUS.IN_PROGRESS }
  );
  const inProgressAttempts = attemptsRes.recordset[0]?.count ?? 0;

  const examRes = await query(
    `SELECT TOP 1 e.title FROM exams e
     WHERE e.status = @status AND (
       e.department_scope = 'all' 
       OR EXISTS (SELECT 1 FROM exam_allowed_departments ead WHERE ead.exam_id = e.id AND ead.department_id = @deptId)
     )`,
    { status: EXAM_STATUS.PUBLISHED, deptId: dept.id }
  );
  const publishedExam = examRes.recordset[0] || null;

  const empPrimaryRes = await query(
    `SELECT COUNT(1) AS count FROM employees e
     JOIN users u ON e.user_id = u.id
     WHERE e.department_id = @deptId AND e.is_active = 1 AND u.is_active = 1`,
    { deptId: dept.id }
  );
  const activePrimary = empPrimaryRes.recordset[0]?.count ?? 0;

  const empExtraRes = await query(
    `SELECT COUNT(1) AS count FROM employee_extra_departments eed
     JOIN employees e ON eed.employee_id = e.id
     JOIN users u ON e.user_id = u.id
     WHERE eed.department_id = @deptId AND e.is_active = 1 AND u.is_active = 1`,
    { deptId: dept.id }
  );
  const activeExtra = empExtraRes.recordset[0]?.count ?? 0;

  const verdict = evaluateDepartmentDeactivation(
    dept.name,
    { inProgressAttempts, publishedExam, activePrimary, activeExtra },
    { force },
  );
  if (verdict) throw new ApiError(409, verdict.message, verdict.code);
}

// Cập nhật thông tin phòng ban
export async function updateDepartment(id, { name, code, description, isActive } = {}, { force = false } = {}) {
  const deptRes = await query('SELECT * FROM departments WHERE id = @id', { id });
  const dept = mapRow(deptRes.recordset[0]);
  assertFound(dept, 'Không tìm thấy bộ phận', 'DEPARTMENT_NOT_FOUND');

  let trimmedName = dept.name;
  let slug = dept.slug;
  if (name !== undefined) {
    trimmedName = name?.trim();
    if (!trimmedName) throw new ApiError(400, 'Tên bộ phận là bắt buộc', 'DEPARTMENT_VALIDATION');
    slug = normalizeDeptName(trimmedName);
  }

  let trimmedCode = dept.code;
  if (code !== undefined) {
    trimmedCode = code ? normalizeDeptCode(code) : '';
    if (!trimmedCode) throw new ApiError(400, 'Mã bộ phận là bắt buộc', 'DEPARTMENT_VALIDATION');
  }

  const newDescription = description !== undefined ? (description?.trim() || '') : dept.description;
  let newIsActive = dept.isActive;
  if (isActive !== undefined) {
    if (!isActive && dept.isActive) await assertDepartmentDeactivatable(dept, { force });
    newIsActive = Boolean(isActive);
  }

  try {
    const updateRes = await query(
      `UPDATE departments
       SET name = @name, slug = @slug, code = @code, description = @description, is_active = @isActive, updated_at = SYSUTCDATETIME()
       OUTPUT INSERTED.*
       WHERE id = @id`,
      {
        id,
        name: trimmedName,
        slug,
        code: trimmedCode,
        description: newDescription,
        isActive: newIsActive,
      }
    );
    return mapRow(updateRes.recordset[0]);
  } catch (err) {
    if (err.number === 2627 || err.number === 2601) {
      throw new ApiError(409, 'Tên hoặc mã bộ phận đã tồn tại', 'DEPARTMENT_DUPLICATE');
    }
    throw err;
  }
}

// Ngừng sử dụng (xóa mềm) phòng ban
export async function deactivateDepartment(id, { force = false } = {}) {
  const deptRes = await query('SELECT * FROM departments WHERE id = @id', { id });
  const dept = mapRow(deptRes.recordset[0]);
  assertFound(dept, 'Không tìm thấy bộ phận', 'DEPARTMENT_NOT_FOUND');
  await assertDepartmentDeactivatable(dept, { force });

  await query('UPDATE departments SET is_active = 0, updated_at = SYSUTCDATETIME() WHERE id = @id', { id });
  return { id: String(dept.id), isActive: false };
}

// Lấy thông tin chi tiết phòng ban theo ID
export async function getDepartmentById(id) {
  const deptRes = await query('SELECT * FROM departments WHERE id = @id', { id });
  const dept = mapRow(deptRes.recordset[0]);
  assertFound(dept, 'Không tìm thấy bộ phận', 'DEPARTMENT_NOT_FOUND');
  return dept;
}

// Đảm bảo các phòng ban trong file Import Excel tồn tại
export async function ensureDepartmentsForImport(items, providedCodes = {}) {
  const deptsRes = await query('SELECT * FROM departments');
  const snapshot = mapRows(deptsRes.recordset);
  const plan = planImportDepartments(items, snapshot, providedCodes);
  if (!plan.ok) {
    throw new ApiError(400, plan.errors.join(' | '), 'IMPORT_DEPARTMENT_INVALID');
  }

  const idByKey = new Map();
  for (const step of plan.steps) {
    try {
      if (step.op === 'create') {
        const slug = normalizeDeptName(step.name);
        const ins = await query(
          `INSERT INTO departments (name, slug, code, description, is_active)
           OUTPUT INSERTED.id VALUES (@name, @slug, @code, '', 1)`,
          { name: step.name, slug, code: step.code }
        );
        idByKey.set(step.key, ins.recordset[0].id);
        continue;
      }
      if (step.reactivate || step.setCode) {
        await query(
          `UPDATE departments SET is_active = 1, code = ISNULL(@code, code), updated_at = SYSUTCDATETIME() WHERE id = @id`,
          { code: step.setCode ? step.code : null, id: step.deptId }
        );
      }
      idByKey.set(step.key, step.deptId);
    } catch (err) {
      if (err.number === 2627 || err.number === 2601) {
        throw new ApiError(409, `Phòng ban "${step.name}" hoặc mã "${step.code}" đã tồn tại`, 'DEPARTMENT_DUPLICATE');
      }
      throw err;
    }
  }
  return idByKey;
}

// Tìm phòng ban theo mã (code)
export async function findDepartmentByCode(code) {
  if (!code) return null;
  const res = await query('SELECT * FROM departments WHERE code = @code AND is_active = 1', { code: String(code).trim() });
  return mapRow(res.recordset[0]);
}
