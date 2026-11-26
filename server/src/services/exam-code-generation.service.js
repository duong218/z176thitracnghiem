/**
 * Service Sinh Mã Đề & Gán Đề Thi cho Thí Sinh (Exam Code Generation Service) - Triển khai SQL Server.
 * Thuật toán sinh đề thi riêng biệt cho từng thí sinh (kết hợp câu hỏi chung và câu hỏi riêng theo phòng ban)
 * và cơ chế bù trừ câu hỏi thông minh.
 */

import crypto from 'node:crypto';
import { query, withTransaction, mapRow, mapRows } from '../db/sql-helpers.js';
import { EXAM_STATUS, QUESTION_SCOPE, QUESTION_USAGE } from '../models/constants.js';
import { ApiError } from '../utils/api-error.js';
import { notificationService } from './notification.service.js';

function shuffle(arr) {
  const result = [...arr];
  for (let i = result.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

function pickRandom(arr, count) {
  return shuffle(arr).slice(0, count);
}

function computeFingerprint(questionIds) {
  const sorted = [...questionIds].map(String).sort();
  return crypto.createHash('sha256').update(sorted.join(',')).digest('hex');
}

function buildExamCode(exam, department, employee) {
  const examId = String(exam.id || exam._id);
  const deptSuffix = (department.code || department.name).replace(/\s+/g, '').toUpperCase().slice(0, 8);
  const empSuffix = (employee.employeeCode || employee.employee_code || 'NV').replace(/\s+/g, '').toUpperCase().slice(0, 8);
  const randomSuffix = crypto.randomBytes(2).toString('hex').toUpperCase();
  return `${examId.slice(-6).toUpperCase()}-${deptSuffix}-${empSuffix}-${randomSuffix}`;
}

export function isCommonCompensationEnabled(exam) {
  return exam?.allowCommonCompensation !== false && exam?.allow_common_compensation !== false;
}

export function resolveDepartmentScope(exam) {
  const mode = (exam?.departmentScope || exam?.department_scope) === 'selected' ? 'selected' : 'all';
  const ids = new Set();
  const rawList = exam?.allowedDepartmentIds || exam?.allowed_department_ids;
  if (mode === 'selected' && Array.isArray(rawList)) {
    for (const raw of rawList) {
      const key = raw?.id || raw?._id ? String(raw.id || raw._id) : String(raw);
      if (key && key !== 'undefined') ids.add(key);
    }
  }
  return { mode, ids };
}

export function isDepartmentInScope(exam, departmentId) {
  const { mode, ids } = resolveDepartmentScope(exam);
  if (mode === 'all') return true;
  return ids.has(String(departmentId));
}

// Object exam đọc bằng "SELECT * FROM exams" không có danh sách phòng được thi -> nạp từ bảng liên kết
async function ensureAllowedDepartments(exam) {
  if ((exam.departmentScope || exam.department_scope) !== 'selected') return;
  if (exam.allowedDepartmentIds || exam.allowed_department_ids) return;
  const res = await query('SELECT department_id FROM exam_allowed_departments WHERE exam_id = @id', {
    id: exam.id || exam._id,
  });
  exam.allowedDepartmentIds = res.recordset.map((r) => String(r.department_id));
}

async function resolveDepartmentEligibility(exam, departmentId) {
  await ensureAllowedDepartments(exam);
  const inScope = isDepartmentInScope(exam, departmentId);
  const topicId = exam.topicId || exam.topic_id;
  const countRes = await query(
    `SELECT COUNT(1) AS count FROM questions
     WHERE topic_id = @topicId AND scope = 'DepartmentSpecific' AND department_id = @deptId
       AND is_active = 1 AND usage = 'exam'`,
    { topicId, deptId: departmentId }
  );
  const deptQuestionCount = countRes.recordset[0]?.count ?? 0;
  const requiredDeptQuestions = exam.departmentQuestionCount ?? exam.department_question_count ?? 0;
  const meetsQuestionRule =
    requiredDeptQuestions === 0 || isCommonCompensationEnabled(exam) || deptQuestionCount >= requiredDeptQuestions;
  const eligible = inScope && meetsQuestionRule;
  let reason = null;
  if (!inScope) reason = 'out_of_scope';
  else if (!meetsQuestionRule) reason = 'insufficient_questions';
  return { eligible, inScope, deptQuestionCount, requiredDeptQuestions, reason };
}

async function validateQuestionAvailability(exam, department, { extraOnly = false } = {}) {
  const deptId = department.id || department._id;
  await ensureAllowedDepartments(exam);
  const inScope = isDepartmentInScope(exam, deptId);
  const requiredDeptQuestions = exam.departmentQuestionCount ?? exam.department_question_count ?? 0;
  const topicId = exam.topicId || exam.topic_id;

  if (!inScope) {
    return {
      eligible: false,
      inScope: false,
      deptQuestionCount: 0,
      requiredDeptQuestions,
      commonQuestions: [],
      deptQuestions: [],
      plan: { commonPickCount: 0, deptPickCount: 0, shortfall: 0 },
    };
  }

  const commonRes = await query(
    `SELECT id FROM questions
     WHERE topic_id = @topicId AND scope = 'Common' AND is_active = 1 AND usage = 'exam'`,
    { topicId }
  );
  const commonQuestions = commonRes.recordset.map((r) => ({ _id: String(r.id), id: String(r.id) }));

  const deptRes = await query(
    `SELECT id FROM questions
     WHERE topic_id = @topicId AND scope = 'DepartmentSpecific' AND department_id = @deptId
       AND is_active = 1 AND usage = 'exam'`,
    { topicId, deptId }
  );
  const deptQuestions = deptRes.recordset.map((r) => ({ _id: String(r.id), id: String(r.id) }));

  const commonRequired = exam.commonQuestionCount ?? exam.common_question_count ?? 0;
  const totalNeeded = commonRequired + requiredDeptQuestions;
  const compensate = isCommonCompensationEnabled(exam);

  const deptPickCount = Math.min(deptQuestions.length, requiredDeptQuestions);
  const shortfall = compensate ? requiredDeptQuestions - deptPickCount : 0;
  const commonPickCount = commonRequired + shortfall;
  const eligible = compensate || requiredDeptQuestions === 0 || deptQuestions.length >= requiredDeptQuestions;

  if (commonQuestions.length < commonPickCount) {
    const totalAvailable = commonQuestions.length + deptQuestions.length;
    throw new ApiError(
      400,
      `Phòng ban "${department.name}" không đủ câu hỏi để tạo đề (cần tổng ${totalNeeded} câu, ` +
        `hiện có ${commonQuestions.length} câu chung + ${deptQuestions.length} câu riêng = ${totalAvailable} câu). ` +
        (extraOnly ? 'Phòng ban này hiện chỉ có nhân viên KIÊM NHIỆM nhưng vẫn cần đủ câu hỏi để họ chọn vai trò này khi thi. ' : '') +
        `Vui lòng bổ sung thêm câu hỏi thi chính thức thuộc chủ đề đã chọn.`,
      'INSUFFICIENT_QUESTIONS',
    );
  }

  return {
    eligible,
    inScope: true,
    deptQuestionCount: deptQuestions.length,
    requiredDeptQuestions,
    commonQuestions,
    deptQuestions,
    plan: { commonPickCount, deptPickCount, shortfall },
  };
}

async function createExamCodeForEmployee(exam, department, employee, commonQuestions, deptQuestions, plan) {
  const commonPick = pickRandom(commonQuestions, plan.commonPickCount);
  const deptPick = pickRandom(deptQuestions, plan.deptPickCount);
  const allQuestions = shuffle([...commonPick, ...deptPick]);
  const fingerprint = computeFingerprint(allQuestions.map((q) => q.id));
  const examId = exam.id || exam._id;
  const deptId = department.id || department._id;
  const code = buildExamCode(exam, department, employee);

  const insRes = await query(
    `INSERT INTO exam_codes (exam_id, code, department_id, question_set_fingerprint)
     OUTPUT INSERTED.*
     VALUES (@examId, @code, @deptId, @fingerprint)`,
    { examId, code, deptId, fingerprint }
  );
  const examCode = mapRow(insRes.recordset[0]);

  for (let index = 0; index < allQuestions.length; index++) {
    await query(
      `INSERT INTO exam_code_questions (exam_code_id, question_id, order_index)
       VALUES (@codeId, @qId, @orderIndex)`,
      { codeId: examCode.id, qId: allQuestions[index].id, orderIndex: index }
    );
  }

  return examCode;
}

async function ensureExamCodeForEmployee(exam, department, employee, precomputedPool) {
  const pool = precomputedPool ?? (await validateQuestionAvailability(exam, department));
  const { eligible, deptQuestionCount, requiredDeptQuestions, commonQuestions, deptQuestions, plan } = pool;

  if (!eligible) {
    throw new ApiError(
      400,
      `Kỳ thi này không dành cho phòng ban "${department.name}" (chưa đủ câu hỏi riêng: ${deptQuestionCount}/${requiredDeptQuestions} câu) nên không thể thi với tư cách phòng ban này.`,
      'ROLE_NOT_ELIGIBLE',
    );
  }

  try {
    return await createExamCodeForEmployee(exam, department, employee, commonQuestions, deptQuestions, plan);
  } catch (err) {
    if (err.number === 2627 || err.number === 2601) {
      return createExamCodeForEmployee(exam, department, employee, commonQuestions, deptQuestions, plan);
    }
    throw err;
  }
}

async function analyzeExamRoles(exam, employees) {
  const mainDeptKeys = new Set();
  const allDeptKeys = new Set();
  for (const emp of employees) {
    if (emp.departmentId || emp.department_id) {
      const pid = String(emp.departmentId || emp.department_id);
      mainDeptKeys.add(pid);
      allDeptKeys.add(pid);
    }
    for (const id of emp.extraDepartmentIds || []) allDeptKeys.add(String(id));
  }

  const deptKeyArray = [...allDeptKeys];
  let departments = [];
  if (deptKeyArray.length > 0) {
    const inClauses = deptKeyArray.map((_, i) => `@d_${i}`);
    const params = Object.fromEntries(deptKeyArray.map((id, i) => [`d_${i}`, id]));
    const res = await query(`SELECT * FROM departments WHERE id IN (${inClauses.join(',')}) AND is_active = 1`, params);
    departments = mapRows(res.recordset);
  }

  const activeDeptKeys = new Set(departments.map((d) => String(d.id)));
  const deptNameByKey = new Map(departments.map((d) => [String(d.id), d.name]));

  const pools = new Map();
  for (const dept of departments) {
    const deptKey = String(dept.id);
    const pool = await validateQuestionAvailability(exam, dept, { extraOnly: !mainDeptKeys.has(deptKey) });
    pools.set(deptKey, pool);
  }

  const employeesByDept = new Map();
  const outOfScopeByDept = new Map();
  let outOfScopeEmployeeCount = 0;

  for (const emp of employees) {
    const empDeptIds = [emp.departmentId || emp.department_id, ...(emp.extraDepartmentIds || [])]
      .filter(Boolean)
      .map(String);
    const activeKeys = empDeptIds.filter((id) => activeDeptKeys.has(id));
    if (activeKeys.length === 0) continue;

    const defaultKey = activeKeys.find((id) => pools.get(id)?.eligible);
    if (!defaultKey) {
      outOfScopeEmployeeCount += 1;
      const mainKey = activeKeys[0];
      outOfScopeByDept.set(mainKey, (outOfScopeByDept.get(mainKey) ?? 0) + 1);
      continue;
    }
    if (!employeesByDept.has(defaultKey)) employeesByDept.set(defaultKey, []);
    employeesByDept.get(defaultKey).push(emp);
  }

  const { mode, ids } = resolveDepartmentScope(exam);
  let selectedZeroEmployeeDeptNames = [];
  if (mode === 'selected' && ids.size > 0) {
    const empCountByDept = new Map();
    for (const emp of employees) {
      const empDeptIds = [emp.departmentId || emp.department_id, ...(emp.extraDepartmentIds || [])]
        .filter(Boolean)
        .map(String);
      for (const id of empDeptIds) {
        empCountByDept.set(id, (empCountByDept.get(id) || 0) + 1);
      }
    }
    for (const id of ids) {
      if ((empCountByDept.get(id) || 0) === 0) {
        selectedZeroEmployeeDeptNames.push(deptNameByKey.get(id) || id);
      }
    }
  }

  return {
    departments,
    pools,
    employeesByDept,
    outOfScopeEmployeeCount,
    outOfScopeByDept,
    deptNameByKey,
    selectedZeroEmployeeDeptNames,
  };
}

export function buildScopeWarnings(analysis) {
  const { outOfScopeEmployeeCount, outOfScopeByDept, deptNameByKey } = analysis;
  if (!outOfScopeEmployeeCount) return null;
  return {
    outOfScopeEmployeeCount,
    outOfScopeDepartments: [...outOfScopeByDept.entries()].map(([departmentId, employeeCount]) => ({
      departmentId,
      name: deptNameByKey.get(departmentId) ?? departmentId,
      employeeCount,
    })),
  };
}

function countInScopeEmployees(analysis) {
  let total = 0;
  for (const arr of analysis.employeesByDept.values()) total += arr.length;
  return total;
}

function buildNoEligibleCandidatesError(exam, analysis) {
  let message =
    'Không có nhân viên nào thuộc phạm vi kỳ thi này. Vui lòng điều chỉnh phạm vi phòng ban hoặc bổ sung câu hỏi.';
  const zeroNames = analysis.selectedZeroEmployeeDeptNames ?? [];
  if (zeroNames.length > 0) {
    message += ` Gợi ý: bỏ chọn các phòng ban không có nhân viên (${zeroNames.join(', ')}) nếu phạm vi hiện chỉ gồm các phòng đó.`;
  }
  return new ApiError(400, message, 'NO_ELIGIBLE_CANDIDATES');
}

export async function assertScopeQuestionsSufficient({
  topicId,
  departmentQuestionCount,
  allowCommonCompensation,
  departmentScope,
  allowedDepartmentIds,
}) {
  if (allowCommonCompensation !== false) return;
  const required = departmentQuestionCount ?? 0;
  if (required === 0) return;

  const examLike = {
    departmentScope,
    allowedDepartmentIds,
    allowCommonCompensation,
    topicId,
    departmentQuestionCount: required,
  };

  const countRes = await query(
    `SELECT department_id, COUNT(1) AS count FROM questions
     WHERE topic_id = @topicId AND scope = 'DepartmentSpecific' AND is_active = 1 AND usage = 'exam'
     GROUP BY department_id`,
    { topicId }
  );
  const countByDeptId = new Map(countRes.recordset.map((r) => [String(r.department_id), r.count]));

  const deptsRes = await query('SELECT id, name FROM departments WHERE is_active = 1 ORDER BY name ASC');
  const departments = mapRows(deptsRes.recordset);

  const empPrimaryRes = await query('SELECT department_id FROM employees WHERE is_active = 1');
  const empExtraRes = await query('SELECT department_id FROM employee_extra_departments');
  const employeeCountByDeptId = new Map();
  for (const r of empPrimaryRes.recordset) {
    if (r.department_id) {
      const k = String(r.department_id);
      employeeCountByDeptId.set(k, (employeeCountByDeptId.get(k) || 0) + 1);
    }
  }
  for (const r of empExtraRes.recordset) {
    if (r.department_id) {
      const k = String(r.department_id);
      employeeCountByDeptId.set(k, (employeeCountByDeptId.get(k) || 0) + 1);
    }
  }

  const { mode, ids } = resolveDepartmentScope(examLike);
  const departmentsToCheck = [];
  if (mode === 'selected') {
    for (const dept of departments) {
      if (ids.has(String(dept.id))) departmentsToCheck.push(dept);
    }
  } else {
    for (const dept of departments) {
      if ((employeeCountByDeptId.get(String(dept.id)) || 0) > 0) departmentsToCheck.push(dept);
    }
  }

  const insufficient = [];
  for (const dept of departmentsToCheck) {
    const key = String(dept.id);
    const count = countByDeptId.get(key) ?? 0;
    if (count < required) {
      insufficient.push({ name: dept.name, count, required });
    }
  }

  if (insufficient.length === 0) return;

  const detail = insufficient.map((d) => `"${d.name}" (${d.count}/${d.required} câu riêng)`).join('; ');
  throw new ApiError(
    400,
    `Không thể lưu: các phòng ban trong phạm vi thi chưa đủ câu hỏi riêng (kỳ thi đang TẮT bù câu chung): ${detail}. ` +
      'Vui lòng bổ sung câu hỏi riêng, bật bù câu chung, hoặc điều chỉnh phạm vi phòng ban.',
    'SCOPE_DEPARTMENT_INSUFFICIENT_QUESTIONS',
  );
}

export async function assertExamPublishable(exam) {
  await assertScopeQuestionsSufficient({
    topicId: exam.topicId || exam.topic_id,
    departmentQuestionCount: exam.departmentQuestionCount ?? exam.department_question_count,
    allowCommonCompensation: exam.allowCommonCompensation ?? exam.allow_common_compensation,
    departmentScope: exam.departmentScope ?? exam.department_scope,
    allowedDepartmentIds: exam.allowedDepartmentIds || exam.allowed_department_ids,
  });

  const empRes = await query('SELECT id, employee_code, department_id FROM employees WHERE is_active = 1');
  const employees = mapRows(empRes.recordset);
  if (employees.length === 0) {
    throw buildNoEligibleCandidatesError(exam, { selectedZeroEmployeeDeptNames: [] });
  }

  const extrasRes = await query('SELECT employee_id, department_id FROM employee_extra_departments');
  const extrasMap = new Map();
  for (const r of extrasRes.recordset) {
    const k = String(r.employee_id);
    const list = extrasMap.get(k) ?? [];
    list.push(String(r.department_id));
    extrasMap.set(k, list);
  }
  for (const emp of employees) {
    emp.extraDepartmentIds = extrasMap.get(String(emp.id)) ?? [];
  }

  const analysis = await analyzeExamRoles(exam, employees);
  if (countInScopeEmployees(analysis) === 0) {
    throw buildNoEligibleCandidatesError(exam, analysis);
  }

  return buildScopeWarnings(analysis);
}

export async function generateExamCodesAndAssignCandidates(exam) {
  const empRes = await query('SELECT id, employee_code, department_id FROM employees WHERE is_active = 1');
  const employees = mapRows(empRes.recordset);
  if (employees.length === 0) {
    throw new ApiError(400, 'Không có nhân viên nào đang hoạt động để gán đề thi', 'NO_ACTIVE_EMPLOYEES');
  }

  const extrasRes = await query('SELECT employee_id, department_id FROM employee_extra_departments');
  const extrasMap = new Map();
  for (const r of extrasRes.recordset) {
    const k = String(r.employee_id);
    const list = extrasMap.get(k) ?? [];
    list.push(String(r.department_id));
    extrasMap.set(k, list);
  }
  for (const emp of employees) {
    emp.extraDepartmentIds = extrasMap.get(String(emp.id)) ?? [];
  }

  await assertScopeQuestionsSufficient({
    topicId: exam.topicId || exam.topic_id,
    departmentQuestionCount: exam.departmentQuestionCount ?? exam.department_question_count,
    allowCommonCompensation: exam.allowCommonCompensation ?? exam.allow_common_compensation,
    departmentScope: exam.departmentScope ?? exam.department_scope,
    allowedDepartmentIds: exam.allowedDepartmentIds || exam.allowed_department_ids,
  });

  const analysis = await analyzeExamRoles(exam, employees);
  if (countInScopeEmployees(analysis) === 0) {
    throw buildNoEligibleCandidatesError(exam, analysis);
  }

  const { departments, employeesByDept, pools } = analysis;
  const examId = exam.id || exam._id;

  for (const dept of departments) {
    const deptKey = String(dept.id);
    const deptEmployees = employeesByDept.get(deptKey) || [];
    if (deptEmployees.length === 0) continue;

    const assignedRes = await query(
      `SELECT employee_id FROM exam_candidates WHERE exam_id = @examId`,
      { examId }
    );
    const alreadyAssignedIds = new Set(assignedRes.recordset.map((c) => String(c.employee_id)));

    const pendingEmployees = deptEmployees.filter((emp) => !alreadyAssignedIds.has(String(emp.id)));
    if (pendingEmployees.length === 0) continue;

    const pool = pools.get(deptKey);
    for (const employee of pendingEmployees) {
      const examCode = await ensureExamCodeForEmployee(exam, dept, employee, pool);
      await query(
        `INSERT INTO exam_candidates (exam_id, employee_id, exam_code_id)
         VALUES (@examId, @empId, @codeId)`,
        { examId, empId: employee.id, codeId: examCode.id }
      );
    }
  }
}

export async function getEmployeeRoleOptions(employee, exam = null) {
  const empId = employee.id || employee._id;
  const primaryId = employee.departmentId || employee.department_id;
  const ids = [];
  if (primaryId) ids.push(String(primaryId));

  const extraRes = await query(
    'SELECT department_id FROM employee_extra_departments WHERE employee_id = @empId',
    { empId }
  );
  for (const r of extraRes.recordset) {
    if (r.department_id) ids.push(String(r.department_id));
  }
  const uniqueIds = [...new Set(ids)];
  if (uniqueIds.length === 0) return [];

  const inClauses = uniqueIds.map((_, i) => `@d_${i}`);
  const params = Object.fromEntries(uniqueIds.map((id, i) => [`d_${i}`, id]));
  const deptsRes = await query(`SELECT * FROM departments WHERE id IN (${inClauses.join(',')}) AND is_active = 1`, params);
  const byId = new Map(deptsRes.recordset.map((d) => [String(d.id), d]));
  const mainKey = primaryId ? String(primaryId) : '';

  const options = uniqueIds
    .map((id) => byId.get(id))
    .filter(Boolean)
    .map((d) => ({
      departmentId: String(d.id),
      _id: String(d.id),
      name: d.name,
      code: d.code ?? null,
      isMain: String(d.id) === mainKey,
      isDefault: false,
      eligible: true,
    }));

  if (exam) {
    for (const option of options) {
      const stats = await resolveDepartmentEligibility(exam, option.departmentId);
      option.eligible = stats.eligible;
      option.inScope = stats.inScope;
      option.reason = stats.reason;
      option.deptQuestionCount = stats.deptQuestionCount;
      option.requiredDeptQuestions = stats.requiredDeptQuestions;
    }
  }

  const defaultOption = options.find((o) => o.eligible);
  if (defaultOption) defaultOption.isDefault = true;
  return options;
}

export async function assignCandidateRole({ exam, examCandidate, employee, departmentId }) {
  const targetKey = String(departmentId ?? '');
  const empId = employee.id || employee._id;
  const primaryId = employee.departmentId || employee.department_id;
  const allowed = [primaryId ? String(primaryId) : null];

  const extraRes = await query('SELECT department_id FROM employee_extra_departments WHERE employee_id = @empId', { empId });
  for (const r of extraRes.recordset) allowed.push(String(r.department_id));

  if (!targetKey || !allowed.filter(Boolean).includes(targetKey)) {
    throw new ApiError(400, 'Vai trò được chọn không thuộc phòng chính hoặc phòng kiêm nhiệm của nhân viên này', 'ROLE_INVALID');
  }

  const deptRes = await query('SELECT * FROM departments WHERE id = @id AND is_active = 1', { id: departmentId });
  const department = mapRow(deptRes.recordset[0]);
  if (!department) throw new ApiError(400, 'Phòng ban được chọn không tồn tại hoặc đã ngừng hoạt động', 'ROLE_INVALID');

  const stats = await resolveDepartmentEligibility(exam, department.id);
  if (!stats.eligible) {
    const message =
      stats.reason === 'out_of_scope'
        ? `Phòng ban "${department.name}" không thuộc phạm vi được thi của kỳ thi này.`
        : `Kỳ thi này không dành cho phòng ban "${department.name}" (chưa đủ câu hỏi riêng: ${stats.deptQuestionCount}/${stats.requiredDeptQuestions} câu) nên không thể chọn làm vai trò thi.`;
    throw new ApiError(400, message, 'ROLE_NOT_ELIGIBLE');
  }

  const candidateId = examCandidate.id || examCandidate._id;
  const currentCodeId = examCandidate.examCodeId || examCandidate.exam_code_id;
  const codeRes = await query('SELECT * FROM exam_codes WHERE id = @id', { id: currentCodeId });
  const currentCode = mapRow(codeRes.recordset[0]);

  if (currentCode && String(currentCode.departmentId || currentCode.department_id) === targetKey) {
    return { examCandidate, examCode: currentCode, changed: false };
  }

  const newCode = await ensureExamCodeForEmployee(exam, department, employee);

  await query('UPDATE exam_candidates SET exam_code_id = @newCodeId, updated_at = SYSUTCDATETIME() WHERE id = @id', {
    newCodeId: newCode.id,
    id: candidateId,
  });

  if (currentCodeId) {
    await query('DELETE FROM exam_code_questions WHERE exam_code_id = @id', { id: currentCodeId });
    await query('DELETE FROM exam_codes WHERE id = @id', { id: currentCodeId });
  }

  return { examCandidate: { ...examCandidate, examCodeId: newCode.id }, examCode: newCode, changed: true };
}

export async function assignEmployeeToActiveExamIfAny(employee) {
  let exam;
  let department;
  try {
    const examRes = await query(`SELECT TOP 1 * FROM exams WHERE status = '${EXAM_STATUS.PUBLISHED}'`);
    exam = mapRow(examRes.recordset[0]);
    if (!exam) return null;

    const empId = employee.id || employee._id;
    const candRes = await query('SELECT * FROM exam_candidates WHERE exam_id = @examId AND employee_id = @empId', {
      examId: exam.id,
      empId,
    });
    if (candRes.recordset.length > 0) return mapRow(candRes.recordset[0]);

    const roleOptions = await getEmployeeRoleOptions(employee, exam);
    if (roleOptions.length === 0) return null;
    const defaultOption = roleOptions.find((o) => o.isDefault);
    if (!defaultOption) {
      if (roleOptions.length === 0 || roleOptions.every((o) => o.inScope === false)) return null;
      throw new ApiError(400, 'Kỳ thi này không dành cho phòng ban nào của nhân viên.', 'NO_ELIGIBLE_ROLE');
    }

    const deptRes = await query('SELECT * FROM departments WHERE id = @id AND is_active = 1', { id: defaultOption.departmentId });
    department = mapRow(deptRes.recordset[0]);
    if (!department) return null;

    const examCode = await ensureExamCodeForEmployee(exam, department, employee);
    const insCand = await query(
      `INSERT INTO exam_candidates (exam_id, employee_id, exam_code_id)
       OUTPUT INSERTED.*
       VALUES (@examId, @empId, @codeId)`,
      { examId: exam.id, empId, codeId: examCode.id }
    );
    return mapRow(insCand.recordset[0]);
  } catch (err) {
    console.error(`[exam-code-generation] Không thể tự động gán đề cho NV ${employee.id || employee._id}: ${err.message}`);
    if (exam) {
      try {
        await notificationService.notifyExamAssignmentFailed({ exam, employee, department, reason: err.message });
      } catch (notifyErr) {
        console.error('notifyExamAssignmentFailed failed:', notifyErr);
      }
    }
    return null;
  }
}
