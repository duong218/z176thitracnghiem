/**
 * Service Quản lý Kỳ thi (Exam Service) - Triển khai SQL Server.
 * Xử lý: Đề xuất kỳ thi, Gửi duyệt, Phê duyệt/Từ chối, Xuất bản kỳ thi (Publish) và Lưu trữ (Archive).
 */

import { query, withTransaction, mapRow, mapRows, toSnake } from '../db/sql-helpers.js';
import { EXAM_STATUS, QUESTION_USAGE, ATTEMPT_TYPE, ATTEMPT_STATUS } from '../models/constants.js';
import { ApiError } from '../utils/api-error.js';
import {
  generateExamCodesAndAssignCandidates,
  assertExamPublishable,
  assertScopeQuestionsSufficient,
} from './exam-code-generation.service.js';
import { notificationService } from './notification.service.js';
import { finalizeAttemptsForReplacedExams, finalizeAttemptsForEndedExams } from './exam-attempt.service.js';

const PUBLISH_LOCK_TTL_MS = 10 * 60 * 1000;
const APPROVE_START_TOLERANCE_MS = 5 * 60 * 1000;
const ACTIVE_ATTEMPT_WINDOW_MS = 60_000;

async function countActiveOfficialAttempts(examIds) {
  if (!examIds.length) return 0;
  const inClauses = examIds.map((_, i) => `@e_${i}`);
  const params = Object.fromEntries(examIds.map((id, i) => [`e_${i}`, id]));
  params.window = ACTIVE_ATTEMPT_WINDOW_MS;

  const res = await query(
    `SELECT COUNT(1) AS count FROM exam_attempts ea
     JOIN exam_candidates ec ON ea.exam_candidate_id = ec.id
     WHERE ec.exam_id IN (${inClauses.join(',')})
       AND ea.attempt_type = 'official'
       AND ea.status = 'in_progress'
       AND ea.expires_at > SYSUTCDATETIME()
       AND (ea.last_active_at IS NULL OR ea.last_active_at >= DATEADD(millisecond, -@window, SYSUTCDATETIME()))`,
    params
  );
  return res.recordset[0]?.count ?? 0;
}

async function getActiveAttemptImpact(excludeExamId) {
  const res = await query(
    `SELECT id, title FROM exams WHERE status = '${EXAM_STATUS.PUBLISHED}' AND id <> @excludeId`,
    { excludeId: excludeExamId }
  );
  const currentExams = res.recordset.map((r) => ({ _id: String(r.id), id: String(r.id), title: r.title }));
  if (currentExams.length === 0) return { activeAttemptCount: 0, currentExams: [] };

  const activeAttemptCount = await countActiveOfficialAttempts(currentExams.map((e) => e.id));
  return { activeAttemptCount, currentExams };
}

async function assertTopicHasExamQuestions(topicId, topicName) {
  const res = await query(
    `SELECT COUNT(1) AS count FROM questions WHERE topic_id = @topicId AND is_active = 1 AND usage = 'exam'`,
    { topicId }
  );
  if ((res.recordset[0]?.count ?? 0) === 0) {
    throw new ApiError(
      400,
      `Chủ đề "${topicName}" chưa có câu hỏi thi chính thức nào (câu thuộc ngân hàng Ôn tập không được dùng để ra đề). ` +
        'Vui lòng chọn chủ đề khác hoặc chuyển câu hỏi sang ngân hàng Thi chính thức.',
      'TOPIC_NO_EXAM_QUESTIONS',
    );
  }
}

async function parseDepartmentScopeFields(payload) {
  const rawScope = payload.departmentScope;
  const departmentScope = rawScope === 'selected' ? 'selected' : 'all';

  if (departmentScope === 'all') {
    return { departmentScope: 'all', allowedDepartmentIds: [] };
  }

  const rawIds = payload.allowedDepartmentIds;
  if (!Array.isArray(rawIds) || rawIds.length === 0) {
    throw new ApiError(400, 'Khi chọn phạm vi theo từng phòng ban, cần chọn ít nhất một phòng ban.', 'EXAM_SCOPE_INVALID');
  }

  const allowedDepartmentIds = rawIds.map(String);
  const inClauses = allowedDepartmentIds.map((_, i) => `@d_${i}`);
  const params = Object.fromEntries(allowedDepartmentIds.map((id, i) => [`d_${i}`, id]));
  const countRes = await query(
    `SELECT COUNT(1) AS count FROM departments WHERE id IN (${inClauses.join(',')}) AND is_active = 1`,
    params
  );
  if ((countRes.recordset[0]?.count ?? 0) !== allowedDepartmentIds.length) {
    throw new ApiError(400, 'Danh sách phòng ban được thi có phòng không tồn tại hoặc đã ngừng hoạt động.', 'EXAM_SCOPE_INVALID');
  }

  return { departmentScope: 'selected', allowedDepartmentIds };
}

// Kiểm tra trước để trả lỗi 400 dễ hiểu, thay vì để ràng buộc CHECK của SQL Server báo lỗi 500
function assertExamFields({ title, duration, totalQ, commonQ, deptQ, passPercent }) {
  const isInt = (v, min) => Number.isInteger(Number(v)) && v !== null && v !== '' && Number(v) >= min;
  const fail = (message) => {
    throw new ApiError(400, message, 'EXAM_FIELDS_INVALID');
  };
  if (typeof title !== 'string' || !title.trim()) fail('Vui lòng nhập tên kỳ thi.');
  if (!isInt(duration, 1)) fail('Thời lượng thi phải là số nguyên lớn hơn 0.');
  if (!isInt(totalQ, 1)) fail('Tổng số câu phải là số nguyên lớn hơn 0.');
  if (!isInt(commonQ, 0) || !isInt(deptQ, 0)) fail('Số câu chung và câu riêng phải là số nguyên không âm.');
  if (Number(totalQ) !== Number(commonQ) + Number(deptQ)) fail('Tổng số câu phải bằng số câu chung cộng số câu riêng.');
  const pass = Number(passPercent);
  if (!(pass >= 0 && pass <= 100)) fail('Ngưỡng đạt phải nằm trong khoảng 0 đến 100.');
}

function serializeExam(row, allowedDepts = []) {
  if (!row) return null;
  // Nhận cả dòng SQL thô (snake_case) lẫn object đã mapRow (camelCase)
  const r = Object.fromEntries(Object.entries(row).map(([k, v]) => [toSnake(k), v]));
  return {
    _id: String(r.id),
    id: String(r.id),
    title: r.title,
    topicId: r.topic_id ? {
      _id: String(r.topic_id),
      id: String(r.topic_id),
      name: r.topic_name,
    } : null,
    startDate: r.start_date,
    endDate: r.end_date,
    durationMinutes: r.duration_minutes,
    totalQuestions: r.total_questions,
    commonQuestionCount: r.common_question_count,
    departmentQuestionCount: r.department_question_count,
    allowCommonCompensation: Boolean(r.allow_common_compensation),
    departmentScope: r.department_scope,
    allowedDepartmentIds: allowedDepts,
    status: r.status,
    passThresholdPercent: Number(r.pass_threshold_percent),
    rejectionReason: r.rejection_reason,
    createdBy: r.created_by ? {
      _id: String(r.created_by),
      id: String(r.created_by),
      username: r.created_by_username,
    } : null,
    approvedBy: r.approved_by ? {
      _id: String(r.approved_by),
      id: String(r.approved_by),
      username: r.approved_by_username,
    } : null,
    approvedAt: r.approved_at,
    publishedAt: r.published_at,
    deletedAt: r.deleted_at,
    deletedByName: r.deleted_by_name,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

const PEER_VISIBLE_STATUSES = [EXAM_STATUS.PENDING_REVIEW, EXAM_STATUS.APPROVED, EXAM_STATUS.PUBLISHED, EXAM_STATUS.ARCHIVED];

export const examService = {
  async listExams(filters = {}) {
    const { status, viewerId, topicId } = filters;
    let where = 'WHERE 1=1';
    const params = {};

    if (status) {
      where += ' AND e.status = @status';
      params.status = status;
    }

    if (viewerId) {
      where += ` AND e.deleted_at IS NULL AND (e.created_by = @viewerId OR e.status IN ('pending_review', 'approved', 'published', 'archived'))`;
      params.viewerId = viewerId;
    }

    if (topicId) {
      where += ' AND e.topic_id = @topicId';
      params.topicId = topicId;
    }

    const dataRes = await query(
      `SELECT e.*, t.name AS topic_name,
              u1.username AS created_by_username,
              u2.username AS approved_by_username
       FROM exams e
       JOIN topics t ON e.topic_id = t.id
       LEFT JOIN users u1 ON e.created_by = u1.id
       LEFT JOIN users u2 ON e.approved_by = u2.id
       ${where}
       ORDER BY e.created_at DESC`,
      params
    );

    const examsRaw = dataRes.recordset;
    if (examsRaw.length === 0) return [];

    const examIds = examsRaw.map((e) => e.id);
    const inClauses = examIds.map((_, i) => `@e_${i}`);
    const eParams = Object.fromEntries(examIds.map((id, i) => [`e_${i}`, id]));

    const eadRes = await query(
      `SELECT ead.exam_id, d.id, d.name, d.code
       FROM exam_allowed_departments ead
       JOIN departments d ON ead.department_id = d.id
       WHERE ead.exam_id IN (${inClauses.join(',')})`,
      eParams
    );
    const deptsByExam = new Map();
    for (const row of eadRes.recordset) {
      const k = String(row.exam_id);
      const list = deptsByExam.get(k) ?? [];
      list.push({ _id: String(row.id), id: String(row.id), name: row.name, code: row.code ?? '' });
      deptsByExam.set(k, list);
    }

    // Họ tên người tạo từ Employees
    const creatorUserIds = [...new Set(examsRaw.map((e) => e.created_by).filter(Boolean).map(String))];
    const creatorsMap = new Map();
    if (creatorUserIds.length > 0) {
      const uIn = creatorUserIds.map((_, i) => `@u_${i}`);
      const uParams = Object.fromEntries(creatorUserIds.map((id, i) => [`u_${i}`, id]));
      const empRes = await query(
        `SELECT e.user_id, e.fullname, d.name AS dept_name
         FROM employees e
         LEFT JOIN departments d ON e.department_id = d.id
         WHERE e.user_id IN (${uIn.join(',')})`,
        uParams
      );
      for (const row of empRes.recordset) {
        creatorsMap.set(String(row.user_id), { name: row.fullname, departmentName: row.dept_name });
      }
    }

    return examsRaw.map((r) => {
      const exam = serializeExam(r, deptsByExam.get(String(r.id)) ?? []);
      const empInfo = creatorsMap.get(String(r.created_by));
      const creator = {
        name: empInfo?.name || r.created_by_username || null,
        departmentName: empInfo?.departmentName || null,
      };

      if (!viewerId) return { ...exam, creator };
      const isMine = String(r.created_by) === String(viewerId);
      if (!isMine) {
        return { _id: exam._id, id: exam.id, title: exam.title, status: exam.status, createdAt: exam.createdAt, creator, isMine };
      }
      return { ...exam, creator, isMine };
    });
  },

  async createExamProposal(payload, userId) {
    const {
      title,
      topicId,
      durationMinutes,
      totalQuestions,
      commonQuestionCount,
      departmentQuestionCount,
      passThresholdPercent,
      allowCommonCompensation,
    } = payload;

    assertExamFields({
      title,
      duration: durationMinutes,
      totalQ: totalQuestions,
      commonQ: commonQuestionCount,
      deptQ: departmentQuestionCount,
      passPercent: passThresholdPercent ?? 70,
    });

    const topicRes = await query('SELECT id, name FROM topics WHERE id = @id', { id: topicId });
    const topic = mapRow(topicRes.recordset[0]);
    if (!topic) throw new ApiError(404, 'Không tìm thấy chủ đề', 'TOPIC_NOT_FOUND');
    await assertTopicHasExamQuestions(topic.id, topic.name);

    const scopeFields = await parseDepartmentScopeFields(payload);
    const allowComp = allowCommonCompensation === true;

    await assertScopeQuestionsSufficient({
      topicId,
      departmentQuestionCount,
      allowCommonCompensation: allowComp,
      departmentScope: scopeFields.departmentScope,
      allowedDepartmentIds: scopeFields.allowedDepartmentIds,
    });

    const insRes = await query(
      `INSERT INTO exams (title, topic_id, duration_minutes, total_questions, common_question_count, department_question_count,
                          pass_threshold_percent, allow_common_compensation, department_scope, created_by, status)
       OUTPUT INSERTED.*
       VALUES (@title, @topicId, @duration, @totalQ, @commonQ, @deptQ, @passPercent, @allowComp, @deptScope, @userId, '${EXAM_STATUS.DRAFT}')`,
      {
        title: title?.trim(),
        topicId,
        duration: durationMinutes,
        totalQ: totalQuestions,
        commonQ: commonQuestionCount,
        deptQ: departmentQuestionCount,
        passPercent: passThresholdPercent ?? 70,
        allowComp: allowComp ? 1 : 0,
        deptScope: scopeFields.departmentScope,
        userId,
      }
    );
    const exam = mapRow(insRes.recordset[0]);

    if (scopeFields.departmentScope === 'selected') {
      for (const dId of scopeFields.allowedDepartmentIds) {
        await query('INSERT INTO exam_allowed_departments (exam_id, department_id) VALUES (@examId, @deptId)', {
          examId: exam.id,
          deptId: dId,
        });
      }
    }

    return serializeExam(exam, scopeFields.allowedDepartmentIds);
  },

  async updateExamProposal(examId, payload, userId) {
    const examRes = await query(
      `SELECT * FROM exams WHERE id = @id AND created_by = @userId AND deleted_at IS NULL`,
      { id: examId, userId }
    );
    const exam = mapRow(examRes.recordset[0]);
    if (!exam) throw new ApiError(404, 'Không tìm thấy kỳ thi', 'EXAM_NOT_FOUND');

    if (![EXAM_STATUS.DRAFT, EXAM_STATUS.REJECTED].includes(exam.status)) {
      throw new ApiError(400, 'Kỳ thi không ở trạng thái hợp lệ để chỉnh sửa', 'EXAM_INVALID_STATUS');
    }

    const {
      title,
      topicId,
      durationMinutes,
      totalQuestions,
      commonQuestionCount,
      departmentQuestionCount,
      passThresholdPercent,
      allowCommonCompensation,
      departmentScope,
    } = payload;

    if (topicId && String(topicId) !== String(exam.topicId || exam.topic_id)) {
      const topicRes = await query('SELECT id, name FROM topics WHERE id = @id', { id: topicId });
      const topic = mapRow(topicRes.recordset[0]);
      if (!topic) throw new ApiError(404, 'Không tìm thấy chủ đề', 'TOPIC_NOT_FOUND');
      await assertTopicHasExamQuestions(topic.id, topic.name);
    }

    const nextTopicId = topicId || exam.topicId || exam.topic_id;
    const nextCommonQ = commonQuestionCount !== undefined ? commonQuestionCount : exam.commonQuestionCount;
    const nextDeptQ = departmentQuestionCount !== undefined ? departmentQuestionCount : exam.departmentQuestionCount;
    const nextTotalQ = totalQuestions !== undefined ? totalQuestions : (nextCommonQ + nextDeptQ);
    assertExamFields({
      title: title ?? exam.title,
      duration: durationMinutes ?? exam.durationMinutes,
      totalQ: nextTotalQ,
      commonQ: nextCommonQ,
      deptQ: nextDeptQ,
      passPercent: passThresholdPercent ?? exam.passThresholdPercent,
    });
    const nextAllowComp = typeof allowCommonCompensation === 'boolean'
      ? allowCommonCompensation
      : Boolean(exam.allowCommonCompensation !== undefined ? exam.allowCommonCompensation : exam.allow_common_compensation);

    let nextScope = exam.departmentScope || exam.department_scope;
    let nextAllowedDeptIds = [];
    if (departmentScope === 'selected' || departmentScope === 'all') {
      const scopeFields = await parseDepartmentScopeFields(payload);
      nextScope = scopeFields.departmentScope;
      nextAllowedDeptIds = scopeFields.allowedDepartmentIds;
    } else if (payload.allowedDepartmentIds !== undefined && nextScope === 'selected') {
      const scopeFields = await parseDepartmentScopeFields({ ...payload, departmentScope: 'selected' });
      nextAllowedDeptIds = scopeFields.allowedDepartmentIds;
    } else if (nextScope === 'selected') {
      // Không gửi phạm vi: giữ nguyên danh sách phòng ban cũ
      const oldRes = await query('SELECT department_id FROM exam_allowed_departments WHERE exam_id = @id', { id: examId });
      nextAllowedDeptIds = oldRes.recordset.map((r) => String(r.department_id));
    }

    await assertScopeQuestionsSufficient({
      topicId: nextTopicId,
      departmentQuestionCount: nextDeptQ,
      allowCommonCompensation: nextAllowComp,
      departmentScope: nextScope,
      allowedDepartmentIds: nextAllowedDeptIds,
    });

    await query(
      `UPDATE exams
       SET title = @title, topic_id = @topicId, duration_minutes = @duration,
           total_questions = @totalQ, common_question_count = @commonQ, department_question_count = @deptQ,
           pass_threshold_percent = @passPercent, allow_common_compensation = @allowComp,
           department_scope = @deptScope, status = '${EXAM_STATUS.DRAFT}', rejection_reason = NULL,
           updated_at = SYSUTCDATETIME()
       WHERE id = @id`,
      {
        title: title?.trim() || exam.title,
        topicId: nextTopicId,
        duration: durationMinutes ?? exam.durationMinutes,
        totalQ: nextTotalQ,
        commonQ: nextCommonQ,
        deptQ: nextDeptQ,
        passPercent: passThresholdPercent ?? exam.passThresholdPercent,
        allowComp: nextAllowComp ? 1 : 0,
        deptScope: nextScope,
        id: examId,
      }
    );

    await query('DELETE FROM exam_allowed_departments WHERE exam_id = @id', { id: examId });
    if (nextScope === 'selected') {
      for (const dId of nextAllowedDeptIds) {
        await query('INSERT INTO exam_allowed_departments (exam_id, department_id) VALUES (@examId, @deptId)', {
          examId,
          deptId: dId,
        });
      }
    }

    const updatedRes = await query('SELECT * FROM exams WHERE id = @id', { id: examId });
    return serializeExam(mapRow(updatedRes.recordset[0]), nextAllowedDeptIds);
  },

  async submitExamForReview(examId, userId) {
    const examRes = await query(
      `SELECT * FROM exams WHERE id = @id AND created_by = @userId AND deleted_at IS NULL`,
      { id: examId, userId }
    );
    const exam = mapRow(examRes.recordset[0]);
    if (!exam) throw new ApiError(404, 'Không tìm thấy kỳ thi', 'EXAM_NOT_FOUND');

    if (![EXAM_STATUS.DRAFT, EXAM_STATUS.REJECTED].includes(exam.status)) {
      throw new ApiError(400, 'Kỳ thi không ở trạng thái hợp lệ để gửi duyệt', 'EXAM_INVALID_STATUS');
    }

    const eadRes = await query('SELECT department_id FROM exam_allowed_departments WHERE exam_id = @id', { id: examId });
    exam.allowedDepartmentIds = eadRes.recordset.map((r) => String(r.department_id));

    const warnings = await assertExamPublishable(exam);

    const updRes = await query(
      `UPDATE exams 
       SET status = '${EXAM_STATUS.PENDING_REVIEW}', updated_at = SYSUTCDATETIME()
       OUTPUT INSERTED.*
       WHERE id = @id AND created_by = @userId AND status IN ('${EXAM_STATUS.DRAFT}', '${EXAM_STATUS.REJECTED}')`,
      { id: examId, userId }
    );
    const submitted = mapRow(updRes.recordset[0]);
    if (!submitted) {
      throw new ApiError(400, 'Kỳ thi không ở trạng thái hợp lệ để gửi duyệt', 'EXAM_INVALID_STATUS');
    }

    try {
      await notificationService.notifyExamSubmitted(submitted);
    } catch (err) {
      console.error('notifyExamSubmitted failed:', err);
    }

    const result = serializeExam(submitted);
    if (warnings) result.warnings = warnings;
    return result;
  },

  async deleteExamProposal(examId, userId) {
    const notFound = () => new ApiError(404, 'Không tìm thấy kỳ thi', 'EXAM_NOT_FOUND');
    const examRes = await query(
      `SELECT * FROM exams WHERE id = @id AND created_by = @userId AND deleted_at IS NULL`,
      { id: examId, userId }
    );
    const exam = mapRow(examRes.recordset[0]);
    if (!exam) throw notFound();

    if ([EXAM_STATUS.DRAFT, EXAM_STATUS.PENDING_REVIEW].includes(exam.status)) {
      await query('DELETE FROM exam_allowed_departments WHERE exam_id = @id', { id: examId });
      await query('DELETE FROM notifications WHERE exam_id = @id', { id: examId });
      await query('DELETE FROM exams WHERE id = @id', { id: examId });
      return { _id: String(exam.id), id: String(exam.id), title: exam.title, status: exam.status, hardDeleted: true };
    }

    if (exam.status === EXAM_STATUS.REJECTED) {
      const empRes = await query('SELECT fullname FROM employees WHERE user_id = @userId', { userId });
      const deletedByName = empRes.recordset[0]?.fullname || 'Người ra đề';
      await query(
        `UPDATE exams SET deleted_at = SYSUTCDATETIME(), deleted_by_name = @name WHERE id = @id`,
        { name: deletedByName, id: examId }
      );
      return { _id: String(exam.id), id: String(exam.id), title: exam.title, status: exam.status, hardDeleted: false };
    }

    const blockedMessage = {
      [EXAM_STATUS.APPROVED]: 'Đề đã được duyệt, không thể xóa',
      [EXAM_STATUS.PUBLISHED]: 'Đề đã được đăng chính thức, không thể xóa',
      [EXAM_STATUS.ARCHIVED]: 'Đề đã được lưu trữ, không thể xóa',
    }[exam.status];
    if (blockedMessage) throw new ApiError(400, blockedMessage, 'EXAM_INVALID_STATUS');
    throw new ApiError(409, 'Kỳ thi vừa được thay đổi ở nơi khác', 'EXAM_CONFLICT');
  },

  async approveExam(examId, { startDate, endDate }, leaderId) {
    if (!startDate || !endDate) throw new ApiError(400, 'Vui lòng cung cấp ngày bắt đầu và kết thúc', 'EXAM_DATES_REQUIRED');
    const start = new Date(startDate);
    const end = new Date(endDate);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
      throw new ApiError(400, 'Ngày giờ bắt đầu hoặc kết thúc không hợp lệ', 'EXAM_DATES_INVALID');
    }
    if (end <= start) throw new ApiError(400, 'Ngày kết thúc phải sau ngày bắt đầu', 'EXAM_DATES_INVALID');
    if (start.getTime() < Date.now() - APPROVE_START_TOLERANCE_MS) {
      throw new ApiError(400, 'Ngày bắt đầu phải từ thời điểm hiện tại trở đi', 'EXAM_DATES_INVALID');
    }

    const updRes = await query(
      `UPDATE exams
       SET status = '${EXAM_STATUS.APPROVED}', start_date = @start, end_date = @end, approved_by = @leaderId, approved_at = SYSUTCDATETIME(), updated_at = SYSUTCDATETIME()
       OUTPUT INSERTED.*
       WHERE id = @id AND status = '${EXAM_STATUS.PENDING_REVIEW}'`,
      { id: examId, start, end, leaderId }
    );
    const exam = mapRow(updRes.recordset[0]);
    if (!exam) throw new ApiError(400, 'Kỳ thi không ở trạng thái chờ duyệt', 'EXAM_INVALID_STATUS');

    try {
      await notificationService.notifyExamApproved(exam);
    } catch (err) {
      console.error('notifyExamApproved failed:', err);
    }

    return serializeExam(exam);
  },

  async rejectExam(examId, rejectionReason, leaderId) {
    if (!rejectionReason?.trim()) throw new ApiError(400, 'Vui lòng cung cấp lý do từ chối', 'REASON_REQUIRED');

    const updRes = await query(
      `UPDATE exams
       SET status = '${EXAM_STATUS.REJECTED}', rejection_reason = @reason, approved_by = @leaderId, updated_at = SYSUTCDATETIME()
       OUTPUT INSERTED.*
       WHERE id = @id AND status = '${EXAM_STATUS.PENDING_REVIEW}'`,
      { id: examId, reason: rejectionReason.trim(), leaderId }
    );
    const exam = mapRow(updRes.recordset[0]);
    if (!exam) throw new ApiError(400, 'Kỳ thi không ở trạng thái chờ duyệt', 'EXAM_INVALID_STATUS');

    try {
      await notificationService.notifyExamRejected(exam);
    } catch (err) {
      console.error('notifyExamRejected failed:', err);
    }

    return serializeExam(exam);
  },

  async publishExam(examId, leaderId, { force = false } = {}) {
    const claimRes = await query(
      `UPDATE exams
       SET publish_locked_at = SYSUTCDATETIME()
       OUTPUT INSERTED.*
       WHERE id = @id AND status = '${EXAM_STATUS.APPROVED}'
         AND (publish_locked_at IS NULL OR publish_locked_at < DATEADD(millisecond, -@ttl, SYSUTCDATETIME()))`,
      { id: examId, ttl: PUBLISH_LOCK_TTL_MS }
    );
    const claimed = mapRow(claimRes.recordset[0]);
    if (!claimed) throw new ApiError(400, 'Kỳ thi không còn ở trạng thái chờ phát hành hoặc đang được phát hành', 'EXAM_INVALID_STATUS');

    const eadRes = await query('SELECT department_id FROM exam_allowed_departments WHERE exam_id = @id', { id: examId });
    claimed.allowedDepartmentIds = eadRes.recordset.map((r) => String(r.department_id));

    let warnings = null;
    let forcedOverActiveAttempts = 0;
    let finalizedAttempts = { finalized: 0, failed: 0 };
    let published = null;

    try {
      if (claimed.endDate && new Date(claimed.endDate) <= new Date()) {
        throw new ApiError(400, 'Kỳ thi đã quá hạn kết thúc, không thể công bố.', 'EXAM_DATES_EXPIRED');
      }

      const impact = await getActiveAttemptImpact(claimed.id);
      if (impact.activeAttemptCount > 0) {
        if (!force) {
          throw new ApiError(
            409,
            `Đang có ${impact.activeAttemptCount} thí sinh làm bài ở kỳ thi "${impact.currentExams[0]?.title}". Xác nhận để tiếp tục.`,
            'EXAM_PUBLISH_ACTIVE_ATTEMPTS',
          );
        }
        forcedOverActiveAttempts = impact.activeAttemptCount;
      }

      warnings = await assertExamPublishable(claimed);
      await generateExamCodesAndAssignCandidates(claimed);

      finalizedAttempts = await finalizeAttemptsForReplacedExams(impact.currentExams.map((e) => e.id));

      const pubRes = await withTransaction(async (txQuery) => {
        await txQuery(
          `UPDATE exams SET status = '${EXAM_STATUS.ARCHIVED}', updated_at = SYSUTCDATETIME()
           WHERE status = '${EXAM_STATUS.PUBLISHED}' AND id <> @id`,
          { id: examId }
        );
        return txQuery(
          `UPDATE exams
           SET status = '${EXAM_STATUS.PUBLISHED}', published_at = SYSUTCDATETIME(), publish_locked_at = NULL, updated_at = SYSUTCDATETIME()
           OUTPUT INSERTED.*
           WHERE id = @id`,
          { id: examId }
        );
      });
      published = mapRow(pubRes.recordset[0]);
    } catch (err) {
      await query('UPDATE exams SET publish_locked_at = NULL WHERE id = @id', { id: examId }).catch(() => {});
      throw err;
    }

    try {
      await notificationService.notifyExamPublished(published, leaderId);
    } catch (err) {
      console.error('notifyExamPublished failed:', err);
    }

    const result = serializeExam(published, claimed.allowedDepartmentIds);
    if (warnings) result.warnings = warnings;
    if (forcedOverActiveAttempts > 0) result.forcedOverActiveAttempts = forcedOverActiveAttempts;
    if (finalizedAttempts.finalized > 0 || finalizedAttempts.failed > 0) result.finalizedAttempts = finalizedAttempts;
    return result;
  },

  async getPublishImpact(examId) {
    const res = await query('SELECT id FROM exams WHERE id = @id', { id: examId });
    if (!res.recordset.length) throw new ApiError(404, 'Không tìm thấy kỳ thi', 'EXAM_NOT_FOUND');
    return getActiveAttemptImpact(examId);
  },

  async archiveExam(examId, leaderId) {
    const res = await query(
      `UPDATE exams
       SET status = '${EXAM_STATUS.ARCHIVED}', approved_by = @leaderId, updated_at = SYSUTCDATETIME()
       OUTPUT INSERTED.*
       WHERE id = @id AND status = '${EXAM_STATUS.APPROVED}'
         AND (publish_locked_at IS NULL OR publish_locked_at < DATEADD(millisecond, -@ttl, SYSUTCDATETIME()))`,
      { id: examId, leaderId, ttl: PUBLISH_LOCK_TTL_MS }
    );
    const exam = mapRow(res.recordset[0]);
    if (!exam) throw new ApiError(400, 'Chỉ có thể bỏ qua kỳ thi đang ở trạng thái chờ phát hành', 'EXAM_INVALID_STATUS');
    return serializeExam(exam);
  },

  async archiveExpiredExams() {
    const expiredRes = await query(
      `SELECT id, title FROM exams WHERE status = '${EXAM_STATUS.PUBLISHED}' AND end_date <= SYSUTCDATETIME()`
    );
    const archived = [];
    for (const exam of expiredRes.recordset) {
      const activeCount = await countActiveOfficialAttempts([String(exam.id)]);
      if (activeCount > 0) continue;

      await finalizeAttemptsForEndedExams([String(exam.id)]);

      const upd = await query(
        `UPDATE exams SET status = '${EXAM_STATUS.ARCHIVED}', updated_at = SYSUTCDATETIME()
         OUTPUT INSERTED.id, INSERTED.title
         WHERE id = @id AND status = '${EXAM_STATUS.PUBLISHED}' AND end_date <= SYSUTCDATETIME()`,
        { id: exam.id }
      );
      if (upd.recordset.length > 0) {
        archived.push({ _id: String(exam.id), id: String(exam.id), title: exam.title });
      }
    }
    return archived;
  },

  async getActiveExam() {
    const res = await query(
      `SELECT e.*, t.name AS topic_name
       FROM exams e
       JOIN topics t ON e.topic_id = t.id
       WHERE e.status = '${EXAM_STATUS.PUBLISHED}'`
    );
    const row = res.recordset[0];
    if (!row) return null;

    const eadRes = await query('SELECT department_id FROM exam_allowed_departments WHERE exam_id = @id', { id: row.id });
    const depts = eadRes.recordset.map((r) => String(r.department_id));

    return serializeExam(mapRow(row), depts);
  },
};
