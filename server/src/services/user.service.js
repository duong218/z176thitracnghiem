/**
 * Service Quản lý Người dùng & Nhân sự (User Service) - Triển khai SQL Server.
 * Xử lý: CRUD tài khoản, Phân quyền Role, Khóa/Mở khóa, Reset mật khẩu, Tái sử dụng tài khoản đã khóa,
 * Xuất thông tin đăng nhập và Import Excel nhân viên 2 bước.
 */

import bcrypt from 'bcrypt';
import crypto from 'crypto';
import fs from 'fs';
import XLSX from 'xlsx';
import ExcelJS from 'exceljs';
import { env } from '../config/env.js';
import { query, withTransaction, mapRow, mapRows } from '../db/sql-helpers.js';
import { ApiError } from '../utils/api-error.js';
import * as auditService from './audit.service.js';
import { assignEmployeeToActiveExamIfAny } from './exam-code-generation.service.js';
import { ensureDepartmentsForImport } from './department.service.js';
import {
  formatDepartmentCell,
  resolveRowDepartments,
  summarizeImportDepartments,
} from '../utils/import-departments.js';
import { ATTEMPT_STATUS } from '../models/constants.js';
import { normalizeDeptName } from '../utils/normalize-dept.js';

const ATTEMPT_ALIVE_WINDOW_MS = 2 * 60_000;

// Lấy danh sách toàn bộ người dùng kèm thông tin vai trò và hồ sơ nhân sự
export async function listUsers() {
  const usersRes = await query(
    `SELECT u.id, u.username, u.role_id, u.must_change_password, u.is_active, u.created_at, u.updated_at,
            r.code AS role_code, r.name AS role_name,
            e.id AS employee_id, e.fullname, e.employee_code, e.department_id, e.dob, e.gender, e.phone, e.address, e.position,
            d.name AS department_name, d.code AS department_code
     FROM users u
     JOIN roles r ON u.role_id = r.id
     LEFT JOIN employees e ON e.user_id = u.id
     LEFT JOIN departments d ON e.department_id = d.id
     ORDER BY u.created_at DESC`
  );

  const extrasRes = await query(
    `SELECT eed.employee_id, d.id AS dept_id, d.name AS dept_name, d.code AS dept_code
     FROM employee_extra_departments eed
     JOIN departments d ON eed.department_id = d.id`
  );
  const extrasByEmpId = new Map();
  for (const row of extrasRes.recordset) {
    const key = String(row.employee_id);
    const list = extrasByEmpId.get(key) ?? [];
    list.push({ _id: String(row.dept_id), id: String(row.dept_id), name: row.dept_name, code: row.dept_code ?? '' });
    extrasByEmpId.set(key, list);
  }

  return usersRes.recordset.map((u) => {
    const empId = u.employee_id ? String(u.employee_id) : null;
    const extraDepts = empId ? (extrasByEmpId.get(empId) ?? []) : [];

    return {
      _id: String(u.id),
      id: String(u.id),
      username: u.username,
      mustChangePassword: Boolean(u.must_change_password),
      isActive: Boolean(u.is_active),
      createdAt: u.created_at,
      updatedAt: u.updated_at,
      roleId: {
        _id: String(u.role_id),
        id: String(u.role_id),
        code: u.role_code,
        name: u.role_name,
      },
      fullname: u.fullname ?? '',
      employeeCode: u.employee_code ?? '',
      departmentId: u.department_id ? String(u.department_id) : '',
      departmentName: u.department_name ?? '',
      departmentCode: u.department_code ?? '',
      extraDepartments: extraDepts,
      dob: u.dob ?? '',
      gender: u.gender ?? '',
      phone: u.phone ?? '',
      address: u.address ?? '',
      position: u.position ?? '',
    };
  });
}

async function generateTempPassword() {
  const tempPassword = crypto.randomInt(100000, 999999).toString();
  const passwordHash = await bcrypt.hash(tempPassword, env.bcryptSaltRounds);
  return { tempPassword, passwordHash };
}

async function findExistingAccountForReuse({ employeeCode, username }) {
  if (employeeCode) {
    const empRes = await query(
      `SELECT e.*, u.id AS u_id, u.username, u.password_hash, u.is_active AS u_is_active, u.role_id
       FROM employees e
       JOIN users u ON e.user_id = u.id
       WHERE e.employee_code = @code`,
      { code: employeeCode }
    );
    if (empRes.recordset.length > 0) {
      const row = empRes.recordset[0];
      const existingUser = {
        _id: String(row.u_id),
        id: String(row.u_id),
        username: row.username,
        passwordHash: row.password_hash,
        isActive: Boolean(row.u_is_active),
        roleId: String(row.role_id),
      };
      const existingEmployee = mapRow(row);
      return { existingUser, existingEmployee };
    }
  }

  if (username) {
    const userRes = await query(
      `SELECT u.*, e.id AS emp_id, e.fullname, e.employee_code, e.department_id
       FROM users u
       LEFT JOIN employees e ON e.user_id = u.id
       WHERE u.username = @username`,
      { username: username.toLowerCase() }
    );
    if (userRes.recordset.length > 0) {
      const row = userRes.recordset[0];
      const existingUser = {
        _id: String(row.id),
        id: String(row.id),
        username: row.username,
        passwordHash: row.password_hash,
        isActive: Boolean(row.is_active),
        roleId: String(row.role_id),
      };
      const existingEmployee = row.emp_id ? {
        _id: String(row.emp_id),
        id: String(row.emp_id),
        fullname: row.fullname,
        employeeCode: row.employee_code,
        departmentId: row.department_id ? String(row.department_id) : null,
      } : null;
      return { existingUser, existingEmployee };
    }
  }

  return { existingUser: null, existingEmployee: null };
}

async function reactivateLockedAccount({
  adminId,
  existingUser,
  existingEmployee,
  newUsername,
  employeeData,
  ipAddress,
}) {
  if (newUsername && newUsername !== existingUser.username) {
    const taken = await query(
      `SELECT id FROM users WHERE username = @username AND id <> @id`,
      { username: newUsername, id: existingUser.id }
    );
    if (taken.recordset.length > 0) {
      throw new ApiError(400, `Username "${newUsername}" đã được tài khoản khác sử dụng`, 'USERNAME_EXISTS');
    }
    existingUser.username = newUsername;
  }

  const { tempPassword, passwordHash } = await generateTempPassword();

  await query(
    `UPDATE users
     SET username = @username, password_hash = @passwordHash, must_change_password = 1,
         is_active = 1, failed_login_attempts = 0, lock_until = NULL, locked_at = NULL,
         token_version = token_version + 1, updated_at = SYSUTCDATETIME()
     WHERE id = @id`,
    { username: existingUser.username, passwordHash, id: existingUser.id }
  );

  let employee = null;
  if (existingEmployee) {
    const empRes = await query(
      `UPDATE employees
       SET fullname = @fullname, department_id = @departmentId,
           employee_code = COALESCE(@employeeCode, employee_code),
           dob = @dob, gender = @gender, phone = @phone, address = @address, position = @position,
           is_active = 1, updated_at = SYSUTCDATETIME()
       OUTPUT INSERTED.* WHERE id = @id`,
      {
        id: existingEmployee.id,
        fullname: employeeData.fullname,
        departmentId: employeeData.departmentId,
        employeeCode: employeeData.employeeCode || null,
        dob: employeeData.dob ?? '',
        gender: employeeData.gender ?? '',
        phone: employeeData.phone ?? '',
        address: employeeData.address ?? '',
        position: employeeData.position ?? '',
      }
    );
    employee = mapRow(empRes.recordset[0]);

    // Đồng bộ phòng kiêm nhiệm
    await query(`DELETE FROM employee_extra_departments WHERE employee_id = @empId`, { empId: employee.id });
    for (const dId of (employeeData.extraDepartmentIds || [])) {
      await query(
        `INSERT INTO employee_extra_departments (employee_id, department_id) VALUES (@empId, @deptId)`,
        { empId: employee.id, deptId: dId }
      );
    }
  } else {
    const empRes = await query(
      `INSERT INTO employees (user_id, department_id, fullname, employee_code, dob, gender, phone, address, position, is_active)
       OUTPUT INSERTED.*
       VALUES (@userId, @departmentId, @fullname, @employeeCode, @dob, @gender, @phone, @address, @position, 1)`,
      {
        userId: existingUser.id,
        departmentId: employeeData.departmentId,
        fullname: employeeData.fullname,
        employeeCode: employeeData.employeeCode || null,
        dob: employeeData.dob ?? '',
        gender: employeeData.gender ?? '',
        phone: employeeData.phone ?? '',
        address: employeeData.address ?? '',
        position: employeeData.position ?? '',
      }
    );
    employee = mapRow(empRes.recordset[0]);
    for (const dId of (employeeData.extraDepartmentIds || [])) {
      await query(
        `INSERT INTO employee_extra_departments (employee_id, department_id) VALUES (@empId, @deptId)`,
        { empId: employee.id, deptId: dId }
      );
    }
  }

  await auditService.writeAudit({
    actorUserId: adminId,
    action: 'Tái sử dụng tài khoản đã khóa',
    resourceType: 'User',
    resourceId: existingUser.id,
    metadata: {
      username: existingUser.username,
      employeeCode: employee?.employeeCode,
      detail: 'Tài khoản của nhân viên đã nghỉ (bị khóa) được cấp lại cho nhân viên mới cùng mã',
    },
    ipAddress,
  });

  delete existingUser.passwordHash;
  return { user: existingUser, tempPassword, employee };
}

async function normalizeExtraDepartmentIds(primaryId, rawIds) {
  if (rawIds === undefined || rawIds === null) return [];
  if (!Array.isArray(rawIds)) throw new ApiError(400, 'extraDepartmentIds phải là mảng', 'INVALID_FIELD');
  const unique = [...new Set(rawIds.map(String))];
  if (unique.includes(String(primaryId))) {
    throw new ApiError(400, 'Phòng kiêm nhiệm không được trùng với phòng chính', 'EXTRA_DEPARTMENT_DUPLICATE');
  }
  if (!unique.length) return [];

  const foundRes = await query(
    `SELECT id, name, code FROM departments WHERE id IN (${unique.map((_, i) => `@id_${i}`).join(',')}) AND is_active = 1`,
    Object.fromEntries(unique.map((id, i) => [`id_${i}`, id]))
  );
  if (foundRes.recordset.length !== unique.length) {
    throw new ApiError(400, 'Có phòng kiêm nhiệm không tồn tại hoặc đã ngừng hoạt động', 'EXTRA_DEPARTMENT_NOT_FOUND');
  }

  const withoutCode = foundRes.recordset.filter((d) => !d.code);
  if (withoutCode.length) {
    throw new ApiError(
      400,
      `Phòng ban ${withoutCode.map((d) => `"${d.name}"`).join(', ')} chưa có mã phòng ban — hãy bổ sung mã ở tab Phòng ban trước khi dùng làm phòng kiêm nhiệm`,
      'EXTRA_DEPARTMENT_NO_CODE',
    );
  }
  return unique;
}

// Tạo tài khoản người dùng mới
export async function createUser({ adminId, username, roleId, ipAddress, employeeInfo }) {
  const roleRes = await query('SELECT id, code, name FROM roles WHERE id = @id', { id: roleId });
  const role = mapRow(roleRes.recordset[0]);
  if (!role) throw new ApiError(400, 'Vai trò không hợp lệ', 'ROLE_NOT_FOUND');

  const isCandidate = role.code === 'candidate';
  if (isCandidate) {
    if (!employeeInfo?.fullname || !employeeInfo?.departmentId) {
      throw new ApiError(400, 'Tài khoản thí sinh bắt buộc phải có họ tên và phòng ban', 'MISSING_EMPLOYEE_FIELDS');
    }
  }

  const extraDepartmentIds = isCandidate
    ? await normalizeExtraDepartmentIds(employeeInfo.departmentId, employeeInfo.extraDepartmentIds)
    : [];

  const { existingUser, existingEmployee } = await findExistingAccountForReuse({
    employeeCode: isCandidate ? employeeInfo?.employeeCode : undefined,
    username,
  });

  if (existingUser) {
    if (existingUser.isActive) {
      const conflictField = existingEmployee?.employeeCode ? 'Mã nhân viên' : 'Tên đăng nhập';
      throw new ApiError(
        409,
        `${conflictField} đã tồn tại và tài khoản đang hoạt động`,
        existingEmployee?.employeeCode ? 'EMPLOYEE_CODE_ACTIVE' : 'USERNAME_EXISTS',
      );
    }

    if (!isCandidate) throw new ApiError(400, 'Tên đăng nhập đã tồn tại', 'USERNAME_EXISTS');

    const { user, tempPassword, employee } = await reactivateLockedAccount({
      adminId,
      existingUser,
      existingEmployee,
      newUsername: username?.toLowerCase(),
      employeeData: { ...employeeInfo, extraDepartmentIds },
      ipAddress,
    });
    await assignEmployeeToActiveExamIfAny(employee).catch(() => {});
    return { user, tempPassword, employee, reused: true };
  }

  const { tempPassword, passwordHash } = await generateTempPassword();

  const userRes = await query(
    `INSERT INTO users (username, role_id, password_hash, must_change_password)
     OUTPUT INSERTED.*
     VALUES (@username, @roleId, @passwordHash, 1)`,
    {
      username: username.toLowerCase(),
      roleId,
      passwordHash,
    }
  );
  const newUser = mapRow(userRes.recordset[0]);

  let employee = null;
  if (isCandidate) {
    try {
      const empRes = await query(
        `INSERT INTO employees (fullname, department_id, user_id, employee_code, is_active)
         OUTPUT INSERTED.*
         VALUES (@fullname, @departmentId, @userId, @employeeCode, 1)`,
        {
          fullname: employeeInfo.fullname,
          departmentId: employeeInfo.departmentId,
          userId: newUser.id,
          employeeCode: employeeInfo.employeeCode || null,
        }
      );
      employee = mapRow(empRes.recordset[0]);
      for (const dId of extraDepartmentIds) {
        await query(
          `INSERT INTO employee_extra_departments (employee_id, department_id) VALUES (@empId, @deptId)`,
          { empId: employee.id, deptId: dId }
        );
      }
    } catch (err) {
      await query(`DELETE FROM users WHERE id = @id`, { id: newUser.id });
      throw new ApiError(400, `Không thể tạo hồ sơ nhân viên: ${err.message}`, 'EMPLOYEE_CREATE_FAILED');
    }

    await assignEmployeeToActiveExamIfAny(employee);
  }

  delete newUser.passwordHash;
  return { user: newUser, tempPassword, employee, reused: false };
}

// Cập nhật vai trò (Role) cho người dùng
export async function updateUserRole({ adminId, userId, newRoleId, ipAddress }) {
  if (String(adminId) === String(userId)) {
    throw new ApiError(403, 'Không thể tự đổi quyền của chính mình', 'CANNOT_CHANGE_OWN_ROLE');
  }

  const userRes = await query('SELECT * FROM users WHERE id = @id', { id: userId });
  const user = mapRow(userRes.recordset[0]);
  if (!user) throw new ApiError(404, 'Không tìm thấy người dùng', 'USER_NOT_FOUND');

  const roleRes = await query('SELECT id, code FROM roles WHERE id = @id', { id: newRoleId });
  const role = mapRow(roleRes.recordset[0]);
  if (!role) throw new ApiError(400, 'Vai trò không hợp lệ', 'ROLE_NOT_FOUND');

  const isCandidate = role.code === 'candidate';
  const empRes = await query('SELECT * FROM employees WHERE user_id = @userId', { userId });
  let employee = mapRow(empRes.recordset[0]);
  if (isCandidate && !employee) {
    throw new ApiError(
      400,
      'Tài khoản chưa có thông tin cá nhân. Bấm biểu tượng bút để nhập họ tên và phòng ban trước khi chuyển thành thí sinh',
      'EMPLOYEE_PROFILE_REQUIRED',
    );
  }

  if (employee) {
    const attemptsRes = await query(
      `SELECT COUNT(1) AS count FROM exam_attempts ea
       JOIN exam_candidates ec ON ea.exam_candidate_id = ec.id
       WHERE ec.employee_id = @empId AND ea.status = @status AND ea.expires_at > SYSUTCDATETIME()
         AND ea.last_active_at >= DATEADD(millisecond, -@window, SYSUTCDATETIME())`,
      { empId: employee.id, status: ATTEMPT_STATUS.IN_PROGRESS, window: ATTEMPT_ALIVE_WINDOW_MS }
    );
    if ((attemptsRes.recordset[0]?.count ?? 0) > 0) {
      throw new ApiError(
        409,
        'Người dùng đang có lượt thi chưa nộp. Hãy đợi họ nộp bài xong rồi mới đổi vai trò',
        'ATTEMPT_IN_PROGRESS',
      );
    }
  }

  await query(
    `UPDATE users SET role_id = @newRoleId, token_version = token_version + 1, updated_at = SYSUTCDATETIME() WHERE id = @id`,
    { newRoleId, id: userId }
  );

  if (employee) {
    await query(
      `UPDATE employees SET is_active = @isActive, updated_at = SYSUTCDATETIME() WHERE user_id = @userId`,
      { isActive: isCandidate ? 1 : 0, userId }
    );
    if (isCandidate) {
      employee.isActive = true;
      await assignEmployeeToActiveExamIfAny(employee).catch(() => {});
    }
  }

  delete user.passwordHash;
  return { ...user, roleId: newRoleId };
}

// Sửa thông tin cá nhân của người dùng
export async function updateUserProfile({ userId, profile }) {
  const userRes = await query('SELECT u.*, r.code AS role_code FROM users u JOIN roles r ON u.role_id = r.id WHERE u.id = @id', { id: userId });
  const user = mapRow(userRes.recordset[0]);
  if (!user) throw new ApiError(404, 'Không tìm thấy người dùng', 'USER_NOT_FOUND');

  const { fullname, departmentId, extraDepartmentIds, employeeCode, dob, gender, phone, address, position } = profile;
  if (!fullname?.trim() || !departmentId) {
    throw new ApiError(400, 'Bắt buộc phải có họ tên và phòng ban', 'MISSING_EMPLOYEE_FIELDS');
  }

  const deptRes = await query('SELECT * FROM departments WHERE id = @id AND is_active = 1', { id: departmentId });
  const dept = mapRow(deptRes.recordset[0]);
  if (!dept) throw new ApiError(400, 'Phòng ban chính không tồn tại hoặc đã ngừng hoạt động', 'DEPARTMENT_NOT_FOUND');

  if (dob && !/^\d{2}\/\d{2}\/\d{4}$/.test(dob)) {
    throw new ApiError(400, 'Ngày sinh phải có dạng dd/mm/yyyy', 'INVALID_FIELD');
  }

  const normalizedExtras = await normalizeExtraDepartmentIds(dept.id, extraDepartmentIds);

  const empRes = await query('SELECT * FROM employees WHERE user_id = @userId', { userId });
  let employee = mapRow(empRes.recordset[0]);

  try {
    if (employee) {
      await query(
        `UPDATE employees
         SET fullname = @fullname, department_id = @departmentId, employee_code = @employeeCode,
             dob = @dob, gender = @gender, phone = @phone, address = @address, position = @position, updated_at = SYSUTCDATETIME()
         WHERE id = @id`,
        {
          id: employee.id,
          fullname: fullname.trim(),
          departmentId: dept.id,
          employeeCode: employeeCode?.trim() || null,
          dob: dob ?? '',
          gender: gender ?? '',
          phone: phone ?? '',
          address: address ?? '',
          position: position ?? '',
        }
      );
    } else {
      const ins = await query(
        `INSERT INTO employees (user_id, fullname, department_id, employee_code, dob, gender, phone, address, position, is_active)
         OUTPUT INSERTED.id
         VALUES (@userId, @fullname, @departmentId, @employeeCode, @dob, @gender, @phone, @address, @position, @isActive)`,
        {
          userId,
          fullname: fullname.trim(),
          departmentId: dept.id,
          employeeCode: employeeCode?.trim() || null,
          dob: dob ?? '',
          gender: gender ?? '',
          phone: phone ?? '',
          address: address ?? '',
          position: position ?? '',
          isActive: user.roleCode === 'candidate' ? 1 : 0,
        }
      );
      employee = { id: ins.recordset[0].id };
    }

    // Cập nhật extra departments
    await query('DELETE FROM employee_extra_departments WHERE employee_id = @empId', { empId: employee.id });
    for (const dId of normalizedExtras) {
      await query('INSERT INTO employee_extra_departments (employee_id, department_id) VALUES (@empId, @deptId)', {
        empId: employee.id,
        deptId: dId,
      });
    }
  } catch (err) {
    if (err.number === 2627 || err.number === 2601) {
      throw new ApiError(409, `Mã nhân viên "${employeeCode}" đã được dùng cho tài khoản khác`, 'EMPLOYEE_CODE_DUPLICATE');
    }
    throw err;
  }

  return { username: user.username, fullname: fullname.trim() };
}

// Khóa hoặc Mở khóa tài khoản
export async function toggleUserLock({ adminId, userId, isActive, ipAddress }) {
  if (String(adminId) === String(userId)) {
    throw new ApiError(403, 'Không thể tự khóa/mở khóa tài khoản của chính mình', 'CANNOT_LOCK_SELF');
  }

  const userRes = await query('SELECT * FROM users WHERE id = @id', { id: userId });
  const user = mapRow(userRes.recordset[0]);
  if (!user) throw new ApiError(404, 'Không tìm thấy người dùng', 'USER_NOT_FOUND');

  await query(
    `UPDATE users 
     SET is_active = @isActive, locked_at = @lockedAt, token_version = token_version + 1, updated_at = SYSUTCDATETIME()
     WHERE id = @id`,
    {
      isActive: isActive ? 1 : 0,
      lockedAt: isActive ? null : new Date(),
      id: userId,
    }
  );

  delete user.passwordHash;
  return { ...user, isActive };
}

// Reset mật khẩu người dùng
export async function resetUserPassword({ adminId, userId, ipAddress }) {
  const userRes = await query('SELECT * FROM users WHERE id = @id', { id: userId });
  const user = mapRow(userRes.recordset[0]);
  if (!user) throw new ApiError(404, 'Không tìm thấy người dùng', 'USER_NOT_FOUND');

  const { tempPassword, passwordHash } = await generateTempPassword();

  await query(
    `UPDATE users 
     SET password_hash = @passwordHash, must_change_password = 1, token_version = token_version + 1, updated_at = SYSUTCDATETIME()
     WHERE id = @id`,
    { passwordHash, id: userId }
  );

  return { tempPassword, user: { username: user.username } };
}

// Xuất file Excel danh sách thông tin đăng nhập của Thí sinh
export async function exportCandidateCredentialsExcel({ adminId, ipAddress }) {
  const usersRes = await query(
    `SELECT u.id, u.username, e.id AS emp_id, e.fullname, e.employee_code, e.position,
            d.name AS department_name
     FROM users u
     JOIN roles r ON u.role_id = r.id
     LEFT JOIN employees e ON e.user_id = u.id
     LEFT JOIN departments d ON e.department_id = d.id
     WHERE r.code = 'candidate' AND u.is_active = 1
     ORDER BY u.username ASC`
  );

  if (!usersRes.recordset.length) {
    throw new ApiError(404, 'Không có tài khoản nhân viên nào đang hoạt động để xuất', 'NO_CANDIDATE_USERS');
  }

  const extrasRes = await query(
    `SELECT eed.employee_id, d.name AS dept_name
     FROM employee_extra_departments eed
     JOIN departments d ON eed.department_id = d.id`
  );
  const extrasMap = new Map();
  for (const row of extrasRes.recordset) {
    const key = String(row.employee_id);
    const list = extrasMap.get(key) ?? [];
    list.push(row.dept_name);
    extrasMap.set(key, list);
  }

  const rows = [];
  for (const u of usersRes.recordset) {
    const { tempPassword, passwordHash } = await generateTempPassword();
    await query(
      `UPDATE users SET password_hash = @passwordHash, must_change_password = 1, token_version = token_version + 1 WHERE id = @id`,
      { passwordHash, id: u.id }
    );

    const extraNames = u.emp_id ? (extrasMap.get(String(u.emp_id)) ?? []) : [];
    rows.push({
      fullname: u.fullname ?? '',
      employeeCode: u.employee_code ?? '',
      departmentName: formatDepartmentCell(u.department_name ?? '', extraNames),
      position: u.position ?? '',
      username: u.username,
      tempPassword,
    });
  }

  const buffer = await buildCredentialsWorkbook(rows);

  await auditService.writeAudit({
    actorUserId: adminId,
    action: 'EXPORT_CANDIDATE_CREDENTIALS',
    resourceType: 'User',
    resourceId: null,
    metadata: { detail: `Xuất danh sách + reset mật khẩu tạm cho ${rows.length} tài khoản nhân viên` },
    ipAddress,
  });

  return { buffer, count: rows.length };
}

async function buildCredentialsWorkbook(rows) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Z176 - Hệ thống thi nội bộ';
  workbook.created = new Date();

  const sheet = workbook.addWorksheet('Danh sách nhân viên', {
    views: [{ state: 'frozen', ySplit: 1 }],
  });

  sheet.columns = [
    { header: 'STT', key: 'stt', width: 6 },
    { header: 'Họ tên', key: 'fullname', width: 26 },
    { header: 'Mã nhân viên', key: 'employeeCode', width: 16 },
    { header: 'Phòng ban', key: 'departmentName', width: 24 },
    { header: 'Chức vụ', key: 'position', width: 20 },
    { header: 'Username', key: 'username', width: 18 },
    { header: 'Mật khẩu tạm', key: 'tempPassword', width: 16 },
  ];

  rows.forEach((r, i) => sheet.addRow({ stt: i + 1, ...r }));

  const headerRow = sheet.getRow(1);
  headerRow.eachCell((cell) => {
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 11 };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF008BC5' } };
    cell.alignment = { vertical: 'middle', horizontal: 'center' };
  });
  headerRow.height = 22;

  for (let i = 2; i <= sheet.rowCount; i++) {
    const row = sheet.getRow(i);
    const isEven = i % 2 === 0;
    row.eachCell((cell, colNumber) => {
      cell.alignment = { vertical: 'middle', horizontal: colNumber === 1 ? 'center' : 'left' };
      if (isEven) {
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF5F9FC' } };
      }
      const isPasswordCol = sheet.getColumn(colNumber).key === 'tempPassword';
      if (isPasswordCol) {
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF3CD' } };
        cell.font = { bold: true };
        cell.alignment = { vertical: 'middle', horizontal: 'center' };
      }
    });
    row.height = 18;
  }

  return workbook.xlsx.writeBuffer();
}

function normalizeKey(key) {
  return String(key ?? '')
    .trim()
    .toLowerCase()
    .replace(/đ/g, 'd')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/\s+/g, '');
}

function mapRowKeys(row) {
  const out = {};
  for (const [k, v] of Object.entries(row)) {
    out[normalizeKey(k)] = v;
  }
  return out;
}

function usernameFromEmployeeCode(code) {
  return String(code)
    .trim()
    .toLowerCase()
    .replace(/đ/g, 'd')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/[^a-z0-9]/g, '');
}

function normalizeDob(v) {
  let d, m, y;
  if (typeof v === 'number') {
    const p = XLSX.SSF.parse_date_code(v);
    if (!p) return '';
    ({ d, m, y } = p);
  } else {
    const t = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(String(v ?? '').trim());
    if (!t) return '';
    [d, m, y] = [Number(t[1]), Number(t[2]), Number(t[3])];
  }
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return '';
  return `${String(d).padStart(2, '0')}/${String(m).padStart(2, '0')}/${y}`;
}

function buildEmployeeImportRow(row, rowIndex, departmentSnapshot) {
  const r = mapRowKeys(row);
  const fullname = r.fullname ?? r.hoten ?? r.hovaten;
  const deptCodeRaw = r.maphongban ?? r.mabophan ?? r.maban ?? r.madepartment;
  const deptCell = r.department ?? r.phongban ?? r.bophan;
  const employeeCodeRaw = r.employeecode ?? r.manhanvien ?? r.manv ?? r.ma ?? r.masonhanvien;
  const dob = r.ngaysinh ?? r.dob ?? '';
  const gender = r.gioitinh ?? r.gender ?? '';
  const phone = r.sodienthoai ?? r.dienthoai ?? r.sdt ?? r.phone ?? '';
  const address = r.diachi ?? r.address ?? '';
  const position = r.chucvu ?? r.position ?? '';

  if (!String(fullname ?? '').trim()) {
    throw new ApiError(400, `Dòng ${rowIndex}: thiếu họ tên`, 'IMPORT_ROW_INVALID');
  }

  const employeeCode = String(employeeCodeRaw ?? '').trim() || `TMP${rowIndex}`;
  const username = usernameFromEmployeeCode(employeeCode);
  if (!username) {
    throw new ApiError(400, `Dòng ${rowIndex}: mã nhân viên "${employeeCode}" không sinh được username hợp lệ`, 'IMPORT_ROW_INVALID');
  }

  const depts = resolveRowDepartments({ cellRaw: deptCell, codeRaw: deptCodeRaw }, departmentSnapshot);
  if (depts.error) {
    throw new ApiError(400, `Dòng ${rowIndex}: ${depts.error}`, 'IMPORT_ROW_INVALID');
  }

  return {
    rowIndex,
    fullname: String(fullname).trim(),
    employeeCode,
    username,
    departmentName: depts.primary.name,
    departmentCode: depts.primary.fileCode,
    extraDepartments: depts.extras,
    extrasProvided: depts.extrasProvided,
    warnings: depts.warnings,
    dob: normalizeDob(dob),
    gender: String(gender ?? '').trim(),
    phone: String(phone ?? '').trim(),
    address: String(address ?? '').trim(),
    position: String(position ?? '').trim(),
  };
}

function readImportRows(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new ApiError(400, 'Không đọc được file upload', 'IMPORT_FILE_MISSING');
  }

  const workbook = XLSX.read(fs.readFileSync(filePath), { type: 'buffer', cellDates: false });
  const sheetName = workbook.SheetNames[0];
  if (!sheetName) throw new ApiError(400, 'File Excel không có sheet', 'IMPORT_EMPTY');

  const rawRows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { defval: '' });
  if (!rawRows.length) throw new ApiError(400, 'Sheet trống', 'IMPORT_EMPTY');

  const rows = [];
  for (let i = 0; i < rawRows.length; i += 1) {
    const rowIndex = i + 2;
    const nonEmptyCellCount = Object.values(rawRows[i]).filter((v) => String(v ?? '').trim() !== '').length;
    if (nonEmptyCellCount <= 1) continue;
    rows.push({ rowIndex, raw: rawRows[i] });
  }
  return rows;
}

async function classifyImportRow(parsed) {
  const { existingUser, existingEmployee } = await findExistingAccountForReuse({
    employeeCode: parsed.employeeCode,
    username: parsed.username,
  });

  if (!existingUser) return { ...parsed, action: 'create' };

  if (!existingUser.isActive) {
    return {
      ...parsed,
      action: 'reuse',
      reuseTarget: {
        userId: existingUser.id,
        username: existingUser.username,
        fullname: existingEmployee?.fullname ?? '(không có hồ sơ)',
        employeeCode: existingEmployee?.employeeCode ?? '',
      },
    };
  }

  const sameEmployeeCode = parsed.employeeCode && existingEmployee?.employeeCode === parsed.employeeCode;
  if (sameEmployeeCode || existingUser.username === parsed.username) {
    return {
      ...parsed,
      action: 'update',
      updateTarget: {
        userId: existingUser.id,
        username: existingUser.username,
        fullname: existingEmployee?.fullname ?? '',
      },
    };
  }

  return {
    ...parsed,
    action: 'conflict',
    conflictWith: {
      username: existingUser.username,
      fullname: existingEmployee?.fullname ?? '',
      employeeCode: existingEmployee?.employeeCode ?? '',
    },
  };
}

export async function previewEmployeesFromExcelFile(filePath) {
  const rows = readImportRows(filePath);
  const deptsRes = await query('SELECT * FROM departments');
  const departmentSnapshot = mapRows(deptsRes.recordset);

  const parsedRows = [];
  const parseErrors = [];
  for (const { rowIndex, raw } of rows) {
    try {
      const parsed = buildEmployeeImportRow(raw, rowIndex, departmentSnapshot);
      parsedRows.push(parsed);
    } catch (err) {
      parseErrors.push({ rowIndex, action: 'error', message: err.message ?? 'Lỗi không xác định' });
    }
  }

  const rowIndexesByCode = new Map();
  for (const p of parsedRows) {
    const list = rowIndexesByCode.get(p.employeeCode) ?? [];
    list.push(p.rowIndex);
    rowIndexesByCode.set(p.employeeCode, list);
  }

  const preview = [];
  let toCreate = 0, toReuse = 0, toUpdate = 0, conflicts = 0, duplicatesInFile = 0;
  let errors = parseErrors.length;

  for (const parsed of parsedRows) {
    const duplicateRowIndexes = (rowIndexesByCode.get(parsed.employeeCode) ?? []).filter((idx) => idx !== parsed.rowIndex);

    if (duplicateRowIndexes.length > 0) {
      duplicatesInFile += 1;
      preview.push({
        ...parsed,
        action: 'duplicate_in_file',
        duplicateRows: duplicateRowIndexes,
        message: `Mã nhân viên "${parsed.employeeCode}" xuất hiện ở nhiều dòng trong cùng file — hãy sửa file để mỗi mã chỉ còn 1 dòng rồi import lại`,
      });
      continue;
    }

    const classified = await classifyImportRow(parsed);
    preview.push(classified);
    if (classified.action === 'create') toCreate += 1;
    else if (classified.action === 'reuse') toReuse += 1;
    else if (classified.action === 'update') toUpdate += 1;
    else if (classified.action === 'conflict') conflicts += 1;
  }

  const merged = [...preview, ...parseErrors].sort((a, b) => a.rowIndex - b.rowIndex);

  try { fs.unlinkSync(filePath); } catch {}

  const writable = merged.filter((r) => ['create', 'reuse', 'update'].includes(r.action));
  const departments = summarizeImportDepartments(
    writable.map((r) => ({
      rowIndex: r.rowIndex,
      primary: { name: r.departmentName, fileCode: r.departmentCode },
      extras: r.extraDepartments,
    })),
    departmentSnapshot,
  );

  return {
    total: rows.length,
    toCreate,
    toReuse,
    toUpdate,
    conflicts,
    duplicatesInFile,
    errors,
    rowsWithWarnings: merged.filter((r) => r.warnings?.length).length,
    departments,
    departmentsNeedingCode: departments.filter((d) => d.needsCode).length,
    rows: merged,
  };
}

export async function confirmEmployeeImportRows(rows, adminId, ipAddress, { departmentCodes } = {}) {
  if (!Array.isArray(rows) || !rows.length) {
    throw new ApiError(400, 'Không có dòng nào để xác nhận import', 'IMPORT_EMPTY');
  }

  const roleRes = await query(`SELECT id FROM roles WHERE code = 'candidate'`);
  const candidateRole = mapRow(roleRes.recordset[0]);
  if (!candidateRole) throw new ApiError(500, 'Không tìm thấy vai trò candidate', 'ROLE_NOT_FOUND');

  const deptMapItems = new Map();
  for (const r of rows) {
    if (!['create', 'reuse', 'update'].includes(r.action)) continue;
    if (r.departmentName) {
      const k = normalizeDeptName(r.departmentName);
      if (!deptMapItems.has(k)) deptMapItems.set(k, { key: k, name: r.departmentName });
    }
    for (const extra of r.extraDepartments || []) {
      if (extra?.name) {
        const k = normalizeDeptName(extra.name);
        if (!deptMapItems.has(k)) deptMapItems.set(k, { key: k, name: extra.name });
      }
    }
  }
  const deptItems = [...deptMapItems.values()];

  const deptMap = await ensureDepartmentsForImport(deptItems, departmentCodes);

  const results = [];
  let createdCount = 0, updatedCount = 0, reusedCount = 0, failedCount = 0;

  for (const row of rows) {
    const { action, rowIndex } = row;
    if (['duplicate_in_file', 'conflict', 'error'].includes(action)) {
      results.push({
        row: rowIndex,
        employeeCode: row.employeeCode,
        username: row.username,
        fullname: row.fullname,
        department: row.departmentName,
        status: 'skipped',
        tempPassword: '',
        message: 'Bỏ qua dòng này (có xung đột hoặc lỗi)',
      });
      continue;
    }

    try {
      const departmentId = deptMap.get(normalizeDeptName(row.departmentName));
      const extraDepartmentIds = (row.extraDepartments || [])
        .map((e) => deptMap.get(normalizeDeptName(e.name)))
        .filter(Boolean);

      if (action === 'reuse' || action === 'update') {
        const targetUserId = row.reuseTarget?.userId || row.updateTarget?.userId;
        const userRes = await query('SELECT * FROM users WHERE id = @id', { id: targetUserId });
        const existingUser = mapRow(userRes.recordset[0]);
        if (!existingUser) {
          throw new ApiError(400, `Dòng ${rowIndex}: tài khoản không còn tồn tại`, 'IMPORT_TARGET_MISSING');
        }

        const empRes = await query('SELECT * FROM employees WHERE user_id = @id', { id: existingUser.id });
        const existingEmployee = mapRow(empRes.recordset[0]);

        if (action === 'reuse') {
          if (existingUser.isActive) {
            throw new ApiError(409, `Dòng ${rowIndex}: tài khoản "${existingUser.username}" đã được mở khóa`, 'IMPORT_TARGET_NO_LONGER_LOCKED');
          }
          const { user, tempPassword, employee: reusedEmployee } = await reactivateLockedAccount({
            adminId,
            existingUser,
            existingEmployee,
            newUsername: row.username,
            employeeData: { ...row, departmentId, extraDepartmentIds },
            ipAddress,
          });
          await assignEmployeeToActiveExamIfAny(reusedEmployee).catch(() => {});
          results.push({
            row: rowIndex,
            employeeCode: row.employeeCode,
            username: user.username,
            fullname: row.fullname,
            department: row.departmentName,
            status: 'reused',
            tempPassword,
            message: `Đã mở khóa và cấp lại tài khoản`,
          });
          reusedCount += 1;
          continue;
        }

        let employeeToAssign = existingEmployee;
        if (existingEmployee) {
          await query(
            `UPDATE employees
             SET fullname = @fullname, department_id = @deptId, employee_code = COALESCE(@code, employee_code),
                 dob = @dob, gender = @gender, phone = @phone, address = @address, position = @position, updated_at = SYSUTCDATETIME()
             WHERE id = @id`,
            {
              fullname: row.fullname,
              deptId: departmentId,
              code: row.employeeCode || null,
              dob: row.dob ?? '',
              gender: row.gender ?? '',
              phone: row.phone ?? '',
              address: row.address ?? '',
              position: row.position ?? '',
              id: existingEmployee.id,
            }
          );
          if (row.extrasProvided) {
            await query('DELETE FROM employee_extra_departments WHERE employee_id = @id', { id: existingEmployee.id });
            for (const dId of extraDepartmentIds) {
              await query('INSERT INTO employee_extra_departments (employee_id, department_id) VALUES (@empId, @dId)', {
                empId: existingEmployee.id,
                dId,
              });
            }
          }
        } else {
          const insEmp = await query(
            `INSERT INTO employees (fullname, department_id, user_id, employee_code, dob, gender, phone, address, position, is_active)
             OUTPUT INSERTED.*
             VALUES (@fullname, @deptId, @userId, @code, @dob, @gender, @phone, @address, @position, 1)`,
            {
              fullname: row.fullname,
              deptId: departmentId,
              userId: existingUser.id,
              code: row.employeeCode || null,
              dob: row.dob ?? '',
              gender: row.gender ?? '',
              phone: row.phone ?? '',
              address: row.address ?? '',
              position: row.position ?? '',
            }
          );
          employeeToAssign = mapRow(insEmp.recordset[0]);
          for (const dId of extraDepartmentIds) {
            await query('INSERT INTO employee_extra_departments (employee_id, department_id) VALUES (@empId, @dId)', {
              empId: employeeToAssign.id,
              dId,
            });
          }
        }

        if (employeeToAssign && employeeToAssign.isActive !== false) {
          await assignEmployeeToActiveExamIfAny(employeeToAssign).catch(() => {});
        }

        results.push({
          row: rowIndex,
          employeeCode: row.employeeCode,
          username: existingUser.username,
          fullname: row.fullname,
          department: row.departmentName,
          status: 'updated',
          tempPassword: '',
          message: 'Đã cập nhật hồ sơ',
        });
        updatedCount += 1;
        continue;
      }

      const userTaken = await query('SELECT id FROM users WHERE username = @username', { username: row.username });
      if (userTaken.recordset.length > 0) {
        throw new ApiError(400, `Dòng ${rowIndex}: username "${row.username}" đã tồn tại`, 'IMPORT_USERNAME_CONFLICT');
      }

      const { tempPassword, passwordHash } = await generateTempPassword();
      const insUser = await query(
        `INSERT INTO users (username, role_id, password_hash, must_change_password)
         OUTPUT INSERTED.*
         VALUES (@username, @roleId, @passwordHash, 1)`,
        { username: row.username, roleId: candidateRole.id, passwordHash }
      );
      const newUser = mapRow(insUser.recordset[0]);

      let employee;
      try {
        const insEmp = await query(
          `INSERT INTO employees (fullname, department_id, user_id, employee_code, dob, gender, phone, address, position, is_active)
           OUTPUT INSERTED.*
           VALUES (@fullname, @deptId, @userId, @code, @dob, @gender, @phone, @address, @position, 1)`,
          {
            fullname: row.fullname,
            deptId: departmentId,
            userId: newUser.id,
            code: row.employeeCode || null,
            dob: row.dob ?? '',
            gender: row.gender ?? '',
            phone: row.phone ?? '',
            address: row.address ?? '',
            position: row.position ?? '',
          }
        );
        employee = mapRow(insEmp.recordset[0]);
        for (const dId of extraDepartmentIds) {
          await query('INSERT INTO employee_extra_departments (employee_id, department_id) VALUES (@empId, @dId)', {
            empId: employee.id,
            dId,
          });
        }
      } catch (err) {
        await query('DELETE FROM users WHERE id = @id', { id: newUser.id });
        throw new ApiError(400, `Dòng ${rowIndex}: không thể tạo hồ sơ nhân viên (${err.message})`, 'EMPLOYEE_CREATE_FAILED');
      }

      await assignEmployeeToActiveExamIfAny(employee).catch(() => {});

      results.push({
        row: rowIndex,
        employeeCode: row.employeeCode,
        username: row.username,
        fullname: row.fullname,
        department: row.departmentName,
        status: 'created',
        tempPassword,
        message: 'Tạo tài khoản thành công',
      });
      createdCount += 1;
    } catch (err) {
      failedCount += 1;
      results.push({
        row: rowIndex,
        employeeCode: row?.employeeCode ?? '',
        username: '',
        fullname: row?.fullname ?? '',
        department: row?.departmentName ?? '',
        status: 'error',
        tempPassword: '',
        message: err.message ?? 'Lỗi không xác định',
      });
    }
  }

  if (createdCount > 0 || updatedCount > 0 || reusedCount > 0) {
    await auditService.writeAudit({
      actorUserId: adminId,
      action: 'Import nhân viên từ Excel',
      resourceType: 'User',
      metadata: { created: createdCount, updated: updatedCount, reused: reusedCount, failed: failedCount },
      ipAddress,
    });
  }

  return {
    total: results.length,
    created: createdCount,
    updated: updatedCount,
    reused: reusedCount,
    failed: failedCount,
    results,
  };
}

export async function updateEmployeeDepartments({ userId, departmentId, extraDepartmentIds }) {
  const empRes = await query('SELECT * FROM employees WHERE user_id = @userId', { userId });
  const employee = mapRow(empRes.recordset[0]);
  if (!employee) {
    throw new ApiError(404, 'Tài khoản này không có hồ sơ nhân viên', 'EMPLOYEE_NOT_FOUND');
  }

  let primaryId = employee.departmentId;
  if (departmentId !== undefined && departmentId !== null && String(departmentId) !== String(employee.departmentId)) {
    const deptRes = await query('SELECT * FROM departments WHERE id = @id AND is_active = 1', { id: departmentId });
    const dept = mapRow(deptRes.recordset[0]);
    if (!dept) throw new ApiError(400, 'Phòng ban chính không tồn tại hoặc đã ngừng hoạt động', 'DEPARTMENT_NOT_FOUND');
    primaryId = dept.id;
  }

  const extrasRes = await query(
    'SELECT department_id FROM employee_extra_departments WHERE employee_id = @empId',
    { empId: employee.id }
  );
  const currentExtras = extrasRes.recordset.map((r) => String(r.department_id));

  const nextExtra = extraDepartmentIds === undefined
    ? currentExtras.filter((id) => id !== String(primaryId))
    : await normalizeExtraDepartmentIds(primaryId, extraDepartmentIds);

  await query('UPDATE employees SET department_id = @deptId, updated_at = SYSUTCDATETIME() WHERE id = @id', {
    deptId: primaryId,
    id: employee.id,
  });

  await query('DELETE FROM employee_extra_departments WHERE employee_id = @empId', { empId: employee.id });
  for (const dId of nextExtra) {
    await query('INSERT INTO employee_extra_departments (employee_id, department_id) VALUES (@empId, @dId)', {
      empId: employee.id,
      dId,
    });
  }

  const deptRes = await query('SELECT name, code FROM departments WHERE id = @id', { id: primaryId });
  const primaryDept = mapRow(deptRes.recordset[0]);

  const extraDeptsRes = nextExtra.length
    ? await query(
        `SELECT id, name, code FROM departments WHERE id IN (${nextExtra.map((_, i) => `@id_${i}`).join(',')})`,
        Object.fromEntries(nextExtra.map((id, i) => [`id_${i}`, id]))
      )
    : { recordset: [] };

  return {
    userId: String(userId),
    fullname: employee.fullname,
    departmentId: String(primaryId),
    departmentName: primaryDept?.name ?? '',
    departmentCode: primaryDept?.code ?? '',
    extraDepartments: extraDeptsRes.recordset.map((d) => ({ _id: String(d.id), id: String(d.id), name: d.name, code: d.code ?? '' })),
  };
}
