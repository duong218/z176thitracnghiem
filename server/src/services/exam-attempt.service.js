/**
 * Service Quản lý Quá trình Thi & Chấm điểm (Exam Attempt Service) - Triển khai SQL Server.
 * Xử lý: Lấy đề thi, Bắt đầu ca thi, Autosave từng câu trả lời, Heartbeat, Chấm điểm server-side và Cấp thêm lượt thi.
 */

import { query, withTransaction, mapRow, mapRows } from '../db/sql-helpers.js';
import { ApiError } from '../utils/api-error.js';

import {
  getEmployeeRoleOptions,
  assignCandidateRole,
  isCommonCompensationEnabled,
} from './exam-code-generation.service.js';
import {
  ATTEMPT_TYPE,
  ATTEMPT_STATUS,
  EXAM_STATUS,
  ROLE_CHOSEN_BY,
} from '../models/constants.js';

const MAX_OFFICIAL_ATTEMPTS = 1;
const INACTIVITY_TIMEOUT_MS = 60_000;
const ABANDONED_ATTEMPT_WINDOW_MS = 2 * 60_000;
const EXAM_REPLACED_MESSAGE =
  'Người duyệt đề vừa đăng một kỳ thi mới nên kỳ thi này đã kết thúc. Hệ thống đã tự động nộp bài với các đáp án bạn đã chọn.';

function resolveMaxAttempts(examCandidate) {
  return MAX_OFFICIAL_ATTEMPTS + (examCandidate.extraAttemptsGranted ?? examCandidate.extra_attempts_granted ?? 0);
}

function shuffle(arr) {
  const result = [...arr];
  for (let i = result.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

async function generateAttemptQuestionSnapshot(attemptId, examCodeId) {
  const ecqRes = await query(
    'SELECT question_id FROM exam_code_questions WHERE exam_code_id = @codeId ORDER BY order_index ASC',
    { codeId: examCodeId }
  );
  const questionIds = ecqRes.recordset.map((r) => String(r.question_id));
  if (questionIds.length === 0) return;

  const inClauses = questionIds.map((_, i) => `@q_${i}`);
  const qParams = Object.fromEntries(questionIds.map((id, i) => [`q_${i}`, id]));
  const ansRes = await query(
    `SELECT id, question_id FROM answers WHERE question_id IN (${inClauses.join(',')})`,
    qParams
  );

  const answersByQuestion = new Map();
  for (const a of ansRes.recordset) {
    const k = String(a.question_id);
    const list = answersByQuestion.get(k) ?? [];
    list.push(String(a.id));
    answersByQuestion.set(k, list);
  }

  const shuffledQIds = shuffle(questionIds);
  for (let index = 0; index < shuffledQIds.length; index++) {
    const qid = shuffledQIds[index];
    const insAQ = await query(
      `INSERT INTO attempt_questions (exam_attempt_id, question_id, order_index)
       OUTPUT INSERTED.id
       VALUES (@attemptId, @qid, @orderIndex)`,
      { attemptId, qid, orderIndex: index }
    );
    const aqId = insAQ.recordset[0].id;
    const shuffledAns = shuffle(answersByQuestion.get(qid) || []);
    for (let aIdx = 0; aIdx < shuffledAns.length; aIdx++) {
      await query(
        `INSERT INTO attempt_question_answers (attempt_question_id, answer_id, order_index)
         VALUES (@aqId, @ansId, @sortOrder)`,
        { aqId, ansId: shuffledAns[aIdx], sortOrder: aIdx }
      );
    }
  }
}

async function buildQuestionsFromSnapshot(attemptId) {
  const aqRes = await query(
    `SELECT aq.id AS aq_id, aq.question_id, aq.order_index,
            q.content, q.question_kind, q.answer_type, q.image_url
     FROM attempt_questions aq
     JOIN questions q ON aq.question_id = q.id
     WHERE aq.exam_attempt_id = @attemptId
     ORDER BY aq.order_index ASC`,
    { attemptId }
  );
  if (aqRes.recordset.length === 0) return [];

  const aqIds = aqRes.recordset.map((r) => r.aq_id);
  const inClauses = aqIds.map((_, i) => `@aq_${i}`);
  const params = Object.fromEntries(aqIds.map((id, i) => [`aq_${i}`, id]));

  const aqaRes = await query(
    `SELECT aqa.attempt_question_id, a.id AS answer_id, a.content
     FROM attempt_question_answers aqa
     JOIN answers a ON aqa.answer_id = a.id
     WHERE aqa.attempt_question_id IN (${inClauses.join(',')})
     ORDER BY aqa.order_index ASC`,
    params
  );

  const optionsByAq = new Map();
  for (const row of aqaRes.recordset) {
    const k = String(row.attempt_question_id);
    const list = optionsByAq.get(k) ?? [];
    list.push({ id: String(row.answer_id), content: row.content });
    optionsByAq.set(k, list);
  }

  return aqRes.recordset.map((aq) => ({
    id: String(aq.question_id),
    orderIndex: aq.order_index,
    content: aq.content,
    questionKind: aq.question_kind,
    answerType: aq.answer_type,
    imageUrl: aq.image_url || null,
    options: optionsByAq.get(String(aq.aq_id)) || [],
  }));
}

async function resolveCandidateContext(userId) {
  const empRes = await query('SELECT * FROM employees WHERE user_id = @userId', { userId });
  const employee = mapRow(empRes.recordset[0]);
  if (!employee) {
    throw new ApiError(404, 'Tài khoản của bạn chưa được liên kết với hồ sơ nhân viên nào', 'EMPLOYEE_NOT_FOUND');
  }

  const examRes = await query(`SELECT TOP 1 * FROM exams WHERE status = '${EXAM_STATUS.PUBLISHED}'`);
  const exam = mapRow(examRes.recordset[0]);
  if (!exam) {
    throw new ApiError(404, 'Hiện không có kỳ thi nào đang diễn ra', 'EXAM_NOT_ACTIVE');
  }

  const candRes = await query(
    'SELECT * FROM exam_candidates WHERE exam_id = @examId AND employee_id = @empId',
    { examId: exam.id, empId: employee.id }
  );
  const examCandidate = mapRow(candRes.recordset[0]);
  if (!examCandidate) {
    throw new ApiError(403, 'Bạn không nằm trong danh sách thí sinh của kỳ thi này', 'NOT_REGISTERED_FOR_EXAM');
  }

  return { employee, exam, examCandidate };
}

async function resolveAttemptContext(userId, attemptId) {
  const empRes = await query('SELECT id FROM employees WHERE user_id = @userId', { userId });
  const employee = mapRow(empRes.recordset[0]);
  if (!employee) throw new ApiError(404, 'Không tìm thấy hồ sơ nhân viên', 'EMPLOYEE_NOT_FOUND');

  const attemptRes = await query(
    `SELECT ea.*, ec.exam_id, ec.employee_id
     FROM exam_attempts ea
     JOIN exam_candidates ec ON ea.exam_candidate_id = ec.id
     WHERE ea.id = @attemptId AND ec.employee_id = @empId`,
    { attemptId, empId: employee.id }
  );
  const attempt = mapRow(attemptRes.recordset[0]);
  if (!attempt) throw new ApiError(404, 'Không tìm thấy lượt thi', 'ATTEMPT_NOT_FOUND');

  const examRes = await query('SELECT * FROM exams WHERE id = @id', { id: attempt.exam_id || attempt.examId });
  const exam = mapRow(examRes.recordset[0]);
  if (!exam) throw new ApiError(404, 'Không tìm thấy kỳ thi của lượt thi này', 'EXAM_NOT_FOUND');

  return { employee, exam, attempt };
}

function toResultPayload(result, autoSubmitReason = null) {
  return {
    score: Number(result.score),
    correctCount: result.correct_count ?? result.correctCount,
    totalQuestions: result.total_questions ?? result.totalQuestions,
    passed: Boolean(result.passed),
    ...(autoSubmitReason ? { autoSubmitReason } : {}),
  };
}

async function gradeAndSubmitAttempt({ attempt, exam, answersPayload, autoSubmitReason = null }) {
  const attemptId = attempt.id || attempt._id;
  const existingRes = await query('SELECT * FROM results WHERE exam_attempt_id = @attemptId', { attemptId });
  if (existingRes.recordset.length > 0) {
    const latestAttemptRes = await query('SELECT auto_submit_reason FROM exam_attempts WHERE id = @attemptId', { attemptId });
    return toResultPayload(mapRow(existingRes.recordset[0]), latestAttemptRes.recordset[0]?.auto_submit_reason);
  }

  const aqRes = await query(
    'SELECT id, question_id FROM attempt_questions WHERE exam_attempt_id = @attemptId',
    { attemptId }
  );
  const questionIds = aqRes.recordset.map((r) => String(r.question_id));

  let correctByQuestion = new Map();
  if (questionIds.length > 0) {
    const inClauses = questionIds.map((_, i) => `@q_${i}`);
    const qParams = Object.fromEntries(questionIds.map((id, i) => [`q_${i}`, id]));
    const corRes = await query(
      `SELECT id, question_id FROM answers WHERE question_id IN (${inClauses.join(',')}) AND is_correct = 1`,
      qParams
    );
    for (const a of corRes.recordset) {
      const k = String(a.question_id);
      const s = correctByQuestion.get(k) ?? new Set();
      s.add(String(a.id));
      correctByQuestion.set(k, s);
    }
  }

  const answersMap = new Map();
  if (Array.isArray(answersPayload)) {
    for (const item of answersPayload) {
      if (!item?.questionId) continue;
      const selected = Array.isArray(item.selectedAnswerIds) ? item.selectedAnswerIds.map(String) : [];
      answersMap.set(String(item.questionId), selected);
    }
  } else {
    const caRes = await query(
      `SELECT ca.id, ca.question_id, cas.answer_id
       FROM candidate_answers ca
       LEFT JOIN candidate_answer_selections cas ON cas.candidate_answer_id = ca.id
       WHERE ca.exam_attempt_id = @attemptId`,
      { attemptId }
    );
    for (const row of caRes.recordset) {
      const qk = String(row.question_id);
      const list = answersMap.get(qk) ?? [];
      if (row.answer_id) list.push(String(row.answer_id));
      answersMap.set(qk, list);
    }
  }

  let correctCount = 0;
  const gradedList = [];
  for (const row of aqRes.recordset) {
    const qid = String(row.question_id);
    const selected = answersMap.get(qid) || [];
    const selectedSet = new Set(selected);
    const correctSet = correctByQuestion.get(qid) || new Set();
    const isCorrect = selectedSet.size === correctSet.size && [...selectedSet].every((id) => correctSet.has(id));
    if (isCorrect) correctCount += 1;
    gradedList.push({ questionId: qid, selected, isCorrect });
  }

  const totalQuestions = aqRes.recordset.length;
  const score = totalQuestions > 0 ? Math.round((correctCount / totalQuestions) * 100) : 0;
  const passPercent = exam.passThresholdPercent ?? exam.pass_threshold_percent ?? 70;
  const passed = score >= passPercent;

  const claimRes = await query(
    `UPDATE exam_attempts
     SET status = 'submitted', submitted_at = SYSUTCDATETIME(), auto_submit_reason = @reason, updated_at = SYSUTCDATETIME()
     OUTPUT INSERTED.*
     WHERE id = @attemptId AND status IN ('in_progress', 'expired')`,
    { attemptId, reason: autoSubmitReason || null }
  );
  const claimed = mapRow(claimRes.recordset[0]);
  if (!claimed) {
    const resRow = await query('SELECT * FROM results WHERE exam_attempt_id = @attemptId', { attemptId });
    if (resRow.recordset.length > 0) {
      return toResultPayload(mapRow(resRow.recordset[0]), autoSubmitReason);
    }
    throw new ApiError(400, 'Lượt thi không ở trạng thái hợp lệ để nộp bài', 'ATTEMPT_INVALID_STATUS');
  }

  // Lưu đáp án thí sinh
  await query(
    `DELETE FROM candidate_answer_selections WHERE candidate_answer_id IN (SELECT id FROM candidate_answers WHERE exam_attempt_id = @attemptId)`,
    { attemptId }
  );
  await query('DELETE FROM candidate_answers WHERE exam_attempt_id = @attemptId', { attemptId });

  for (const item of gradedList) {
    const insCA = await query(
      `INSERT INTO candidate_answers (exam_attempt_id, question_id, is_correct)
       OUTPUT INSERTED.id
       VALUES (@attemptId, @qid, @isCorrect)`,
      { attemptId, qid: item.questionId, isCorrect: item.isCorrect ? 1 : 0 }
    );
    const caId = insCA.recordset[0].id;
    for (const ansId of item.selected) {
      await query(
        `INSERT INTO candidate_answer_selections (candidate_answer_id, answer_id) VALUES (@caId, @ansId)`,
        { caId, ansId }
      );
    }
  }

  const insRes = await query(
    `INSERT INTO results (exam_attempt_id, score, correct_count, total_questions, passed)
     OUTPUT INSERTED.*
     VALUES (@attemptId, @score, @correctCount, @totalQ, @passed)`,
    {
      attemptId,
      score,
      correctCount,
      totalQ: totalQuestions,
      passed: passed ? 1 : 0,
    }
  );
  const result = mapRow(insRes.recordset[0]);
  return toResultPayload(result, claimed.auto_submit_reason || claimed.autoSubmitReason);
}

async function finalizeIfExamReplaced(attempt, exam) {
  if (exam.status === EXAM_STATUS.PUBLISHED) return attempt;
  if (attempt.status !== ATTEMPT_STATUS.IN_PROGRESS) return attempt;
  if (exam.endDate && new Date(exam.endDate).getTime() <= Date.now()) return attempt;
  await gradeAndSubmitAttempt({ attempt, exam, autoSubmitReason: 'exam_replaced' });
  const refetch = await query('SELECT * FROM exam_attempts WHERE id = @id', { id: attempt.id || attempt._id });
  return mapRow(refetch.recordset[0]);
}

async function getOfficialAttempts(examCandidateId) {
  const res = await query(
    `SELECT * FROM exam_attempts WHERE exam_candidate_id = @candId AND attempt_type = 'official' ORDER BY created_at DESC`,
    { candId: examCandidateId }
  );
  return mapRows(res.recordset);
}

async function expireIfNeeded(attempt) {
  if (
    attempt.status === ATTEMPT_STATUS.IN_PROGRESS &&
    attempt.expiresAt &&
    new Date(attempt.expiresAt).getTime() <= Date.now()
  ) {
    await query(`UPDATE exam_attempts SET status = 'expired', updated_at = SYSUTCDATETIME() WHERE id = @id`, {
      id: attempt.id || attempt._id,
    });
    attempt.status = ATTEMPT_STATUS.EXPIRED;
  }
  return attempt;
}

async function checkAndAutoSubmitIfInactive(attempt, userId) {
  if (attempt.status !== ATTEMPT_STATUS.IN_PROGRESS) return attempt;
  if (!attempt.lastActiveAt) return attempt;

  const idleMs = Date.now() - new Date(attempt.lastActiveAt).getTime();
  if (idleMs <= INACTIVITY_TIMEOUT_MS) return attempt;

  await examAttemptService.submitAttempt(userId, String(attempt.id || attempt._id), null, 'inactive_timeout');
  const refetch = await query('SELECT * FROM exam_attempts WHERE id = @id', { id: attempt.id || attempt._id });
  return mapRow(refetch.recordset[0]);
}

async function buildRoleInfo(employee, exam, examCandidate, examCode) {
  const options = await getEmployeeRoleOptions(employee, exam);
  const eligibleOptions = options.filter((o) => o.eligible);
  const currentKey = examCode?.department_id || examCode?.departmentId ? String(examCode.department_id || examCode.departmentId) : null;
  const current = options.find((o) => String(o.departmentId) === currentKey) ?? eligibleOptions[0] ?? options[0] ?? null;

  let hasDepartmentQuestions = true;
  if (current && examCode) {
    const codeId = examCode.id || examCode._id;
    const countRes = await query(
      `SELECT COUNT(1) AS count FROM exam_code_questions ecq
       JOIN questions q ON ecq.question_id = q.id
       WHERE ecq.exam_code_id = @codeId AND q.department_id = @deptId`,
      { codeId, deptId: current.departmentId }
    );
    hasDepartmentQuestions = (countRes.recordset[0]?.count ?? 0) > 0;
  }

  const roleConfirmedAt = examCandidate.roleConfirmedAt || examCandidate.role_confirmed_at;
  const roleChosenBy = examCandidate.roleChosenBy || examCandidate.role_chosen_by;

  return {
    departmentId: current?.departmentId ?? null,
    name: current?.name ?? null,
    isMain: current?.isMain ?? false,
    locked: Boolean(roleConfirmedAt) || options.length <= 1,
    chosenBy: roleChosenBy ?? (options.length <= 1 ? ROLE_CHOSEN_BY.SYSTEM : null),
    hasDepartmentQuestions,
    allowCommonCompensation: isCommonCompensationEnabled(exam),
    hasEligibleRole: eligibleOptions.length > 0,
    options: options.map((o) => ({
      departmentId: o.departmentId,
      name: o.name,
      code: o.code,
      isMain: o.isMain,
      eligible: o.eligible,
      inScope: o.inScope,
      reason: o.reason ?? null,
      deptQuestionCount: o.deptQuestionCount ?? 0,
      requiredDeptQuestions: o.requiredDeptQuestions ?? 0,
    })),
  };
}

export const examAttemptService = {
  async getMyExam(userId) {
    const { employee, exam, examCandidate } = await resolveCandidateContext(userId);
    const maxAttempts = resolveMaxAttempts(examCandidate);

    let attempts = await getOfficialAttempts(examCandidate.id);
    for (const attempt of attempts) {
      await expireIfNeeded(attempt);
    }

    const inProgressBefore = attempts.find((a) => a.status === ATTEMPT_STATUS.IN_PROGRESS);
    let autoSubmitted = null;

    if (inProgressBefore) {
      const afterCheck = await checkAndAutoSubmitIfInactive(inProgressBefore, userId);
      if (afterCheck.status !== ATTEMPT_STATUS.IN_PROGRESS) {
        autoSubmitted = { reason: afterCheck.autoSubmitReason || afterCheck.auto_submit_reason || 'inactive_timeout' };
      }
      attempts = await getOfficialAttempts(examCandidate.id);
    }

    const inProgress = attempts.find((a) => a.status === ATTEMPT_STATUS.IN_PROGRESS);
    if (inProgress) {
      await query('UPDATE exam_attempts SET last_active_at = SYSUTCDATETIME() WHERE id = @id', { id: inProgress.id });
    }

    const codeId = examCandidate.examCodeId || examCandidate.exam_code_id;
    const codeRes = await query('SELECT code, department_id FROM exam_codes WHERE id = @id', { id: codeId });
    const examCode = mapRow(codeRes.recordset[0]);
    const role = await buildRoleInfo(employee, exam, examCandidate, examCode);

    const finishedCount = attempts.filter((a) => a.status !== ATTEMPT_STATUS.IN_PROGRESS).length;
    const canTake = Boolean(inProgress) || finishedCount < maxAttempts;

    let questions = [];
    let savedAnswers = [];
    if (canTake) {
      if (inProgress) {
        questions = await buildQuestionsFromSnapshot(inProgress.id);
        const caRes = await query(
          `SELECT ca.question_id, cas.answer_id
           FROM candidate_answers ca
           JOIN candidate_answer_selections cas ON cas.candidate_answer_id = ca.id
           WHERE ca.exam_attempt_id = @id`,
          { id: inProgress.id }
        );
        const mapAnswers = new Map();
        for (const r of caRes.recordset) {
          const qk = String(r.question_id);
          const list = mapAnswers.get(qk) ?? [];
          list.push(String(r.answer_id));
          mapAnswers.set(qk, list);
        }
        savedAnswers = [...mapAnswers.entries()].map(([qid, sIds]) => ({
          questionId: qid,
          selectedAnswerIds: sIds,
        }));
      } else {
        const ecqRes = await query(
          `SELECT ecq.order_index, q.id AS q_id, q.content, q.question_kind, q.answer_type, q.image_url
           FROM exam_code_questions ecq
           JOIN questions q ON ecq.question_id = q.id
           WHERE ecq.exam_code_id = @codeId
           ORDER BY ecq.order_index ASC`,
          { codeId }
        );
        const qRows = ecqRes.recordset;
        if (qRows.length > 0) {
          const qIds = qRows.map((r) => r.q_id);
          const inClauses = qIds.map((_, i) => `@q_${i}`);
          const params = Object.fromEntries(qIds.map((id, i) => [`q_${i}`, id]));
          const ansRes = await query(
            `SELECT id, question_id, content FROM answers WHERE question_id IN (${inClauses.join(',')}) ORDER BY sort_order ASC`,
            params
          );
          const ansMap = new Map();
          for (const a of ansRes.recordset) {
            const k = String(a.question_id);
            const list = ansMap.get(k) ?? [];
            list.push({ id: String(a.id), content: a.content });
            ansMap.set(k, list);
          }
          questions = qRows.map((r) => ({
            id: String(r.q_id),
            orderIndex: r.order_index,
            content: r.content,
            questionKind: r.question_kind,
            answerType: r.answer_type,
            imageUrl: r.image_url || null,
            options: ansMap.get(String(r.q_id)) || [],
          }));
        }
      }
    }

    return {
      exam: {
        id: String(exam.id),
        title: exam.title,
        code: examCode?.code ?? null,
        durationMinutes: exam.durationMinutes ?? exam.duration_minutes,
        passThresholdPercent: exam.passThresholdPercent ?? exam.pass_threshold_percent,
        totalQuestions: exam.totalQuestions ?? exam.total_questions,
      },
      attempt: inProgress ? {
        id: String(inProgress.id),
        status: inProgress.status,
        startedAt: inProgress.startedAt || inProgress.started_at,
        expiresAt: inProgress.expiresAt || inProgress.expires_at,
      } : null,
      attemptsUsed: finishedCount,
      maxAttempts,
      canTake,
      role,
      questions,
      savedAnswers,
      autoSubmitted,
    };
  },

  async startAttempt(userId, { departmentId } = {}) {
    const { employee, exam, examCandidate } = await resolveCandidateContext(userId);
    const maxAttempts = resolveMaxAttempts(examCandidate);

    const attempts = await getOfficialAttempts(examCandidate.id);
    for (const attempt of attempts) {
      await expireIfNeeded(attempt);
    }

    const inProgress = attempts.find((a) => a.status === ATTEMPT_STATUS.IN_PROGRESS);
    if (inProgress) {
      await query('UPDATE exam_attempts SET last_active_at = SYSUTCDATETIME() WHERE id = @id', { id: inProgress.id });
      return {
        attemptId: String(inProgress.id),
        startedAt: inProgress.startedAt || inProgress.started_at,
        expiresAt: inProgress.expiresAt || inProgress.expires_at,
        resumed: true,
      };
    }

    const fmtVN = (d) => new Date(d).toLocaleString('vi-VN');
    const nowMs = Date.now();
    const startDate = exam.startDate || exam.start_date;
    const endDate = exam.endDate || exam.end_date;

    if (startDate && nowMs < new Date(startDate).getTime()) {
      throw new ApiError(403, `Kỳ thi chưa bắt đầu. Thời gian bắt đầu: ${fmtVN(startDate)}.`, 'EXAM_NOT_STARTED');
    }
    if (endDate && nowMs > new Date(endDate).getTime()) {
      throw new ApiError(403, `Kỳ thi "${exam.title}" đã kết thúc lúc ${fmtVN(endDate)}, không thể bắt đầu lượt thi mới.`, 'EXAM_ENDED');
    }

    const finishedCount = attempts.filter((a) => a.status !== ATTEMPT_STATUS.IN_PROGRESS).length;
    if (finishedCount >= maxAttempts) {
      throw new ApiError(400, 'Bạn đã sử dụng hết lượt thi chính thức.', 'ATTEMPT_LIMIT_REACHED');
    }

    const roleOptions = await getEmployeeRoleOptions(employee, exam);
    const eligibleOptions = roleOptions.filter((o) => o.eligible);
    if (eligibleOptions.length === 0) {
      throw new ApiError(400, 'Kỳ thi này không dành cho phòng ban nào của bạn.', 'ROLE_NOT_ELIGIBLE');
    }

    const candRoleConfirmedAt = examCandidate.roleConfirmedAt || examCandidate.role_confirmed_at;
    const candExamCodeId = examCandidate.examCodeId || examCandidate.exam_code_id;

    if (!candRoleConfirmedAt) {
      if (eligibleOptions.length === 1) {
        await assignCandidateRole({ exam, examCandidate, employee, departmentId: eligibleOptions[0].departmentId });
        await query(
          `UPDATE exam_candidates SET role_chosen_by = '${ROLE_CHOSEN_BY.SYSTEM}', role_confirmed_at = SYSUTCDATETIME() WHERE id = @id`,
          { id: examCandidate.id }
        );
      } else {
        const codeRes = await query('SELECT department_id FROM exam_codes WHERE id = @id', { id: candExamCodeId });
        const currentCode = mapRow(codeRes.recordset[0]);
        const target = departmentId ?? currentCode?.department_id ?? eligibleOptions[0].departmentId;
        await assignCandidateRole({ exam, examCandidate, employee, departmentId: target });
        await query(
          `UPDATE exam_candidates SET role_chosen_by = '${ROLE_CHOSEN_BY.CANDIDATE}', role_confirmed_at = SYSUTCDATETIME() WHERE id = @id`,
          { id: examCandidate.id }
        );
      }
    } else if (departmentId) {
      const lockedRes = await query('SELECT department_id FROM exam_codes WHERE id = @id', { id: candExamCodeId });
      const lockedCode = mapRow(lockedRes.recordset[0]);
      if (lockedCode && String(lockedCode.department_id) !== String(departmentId)) {
        throw new ApiError(409, 'Vai trò thi đã được khóa cho kỳ thi này.', 'ROLE_LOCKED');
      }
    }

    const refetchCand = await query('SELECT exam_code_id FROM exam_candidates WHERE id = @id', { id: examCandidate.id });
    const finalCodeId = refetchCand.recordset[0]?.exam_code_id;
    const finalCodeRes = await query('SELECT department_id FROM exam_codes WHERE id = @id', { id: finalCodeId });
    const finalDeptId = finalCodeRes.recordset[0]?.department_id;
    const finalRole = roleOptions.find((o) => String(o.departmentId) === String(finalDeptId));

    const duration = exam.durationMinutes ?? exam.duration_minutes ?? 60;
    const startedAt = new Date();
    const expiresAt = new Date(startedAt.getTime() + duration * 60_000);

    const insAtt = await query(
      `INSERT INTO exam_attempts (exam_candidate_id, attempt_type, department_id, started_at, expires_at, status, last_active_at)
       OUTPUT INSERTED.*
       VALUES (@candId, '${ATTEMPT_TYPE.OFFICIAL}', @deptId, @startedAt, @expiresAt, '${ATTEMPT_STATUS.IN_PROGRESS}', @startedAt)`,
      {
        candId: examCandidate.id,
        deptId: finalDeptId || null,
        startedAt,
        expiresAt,
      }
    );
    const attempt = mapRow(insAtt.recordset[0]);

    await generateAttemptQuestionSnapshot(attempt.id, finalCodeId);

    return {
      attemptId: String(attempt.id),
      startedAt: attempt.startedAt || attempt.started_at,
      expiresAt: attempt.expiresAt || attempt.expires_at,
      resumed: false,
      roleName: finalRole?.name ?? null,
    };
  },

  async recordAnswer(userId, attemptId, questionId, selectedAnswerIds) {
    if (!questionId) throw new ApiError(400, 'Thiếu questionId', 'QUESTION_ID_REQUIRED');
    const { exam, attempt: found } = await resolveAttemptContext(userId, attemptId);

    let attempt = await expireIfNeeded(found);
    attempt = await finalizeIfExamReplaced(attempt, exam);
    attempt = await checkAndAutoSubmitIfInactive(attempt, userId);

    if (attempt.status !== ATTEMPT_STATUS.IN_PROGRESS) {
      const reason = attempt.autoSubmitReason || attempt.auto_submit_reason;
      if (reason === 'exam_replaced') throw new ApiError(409, EXAM_REPLACED_MESSAGE, 'EXAM_REPLACED');
      if (reason === 'exam_ended') throw new ApiError(409, 'Kỳ thi đã kết thúc.', 'EXAM_CLOSED');
      throw new ApiError(400, 'Lượt thi không còn ở trạng thái đang làm bài', 'ATTEMPT_INVALID_STATUS');
    }

    const existingRes = await query(
      'SELECT id FROM candidate_answers WHERE exam_attempt_id = @attemptId AND question_id = @qid',
      { attemptId, qid: questionId }
    );
    let caId;
    if (existingRes.recordset.length > 0) {
      caId = existingRes.recordset[0].id;
      await query('DELETE FROM candidate_answer_selections WHERE candidate_answer_id = @caId', { caId });
    } else {
      const insCA = await query(
        `INSERT INTO candidate_answers (exam_attempt_id, question_id, is_correct)
         OUTPUT INSERTED.id VALUES (@attemptId, @qid, 0)`,
        { attemptId, qid: questionId }
      );
      caId = insCA.recordset[0].id;
    }

    const answers = Array.isArray(selectedAnswerIds) ? selectedAnswerIds : [];
    for (const ansId of answers) {
      await query('INSERT INTO candidate_answer_selections (candidate_answer_id, answer_id) VALUES (@caId, @ansId)', {
        caId,
        ansId,
      });
    }

    const upd = await query(
      `UPDATE exam_attempts SET last_active_at = SYSUTCDATETIME() OUTPUT INSERTED.last_active_at WHERE id = @id`,
      { id: attemptId }
    );

    return { attemptId, savedAt: upd.recordset[0]?.last_active_at };
  },

  async heartbeat(userId, attemptId) {
    const { exam, attempt: found } = await resolveAttemptContext(userId, attemptId);
    let attempt = await expireIfNeeded(found);
    attempt = await finalizeIfExamReplaced(attempt, exam);
    attempt = await checkAndAutoSubmitIfInactive(attempt, userId);

    if (attempt.status === ATTEMPT_STATUS.IN_PROGRESS) {
      await query('UPDATE exam_attempts SET last_active_at = SYSUTCDATETIME() WHERE id = @id', { id: attemptId });
    }

    const reason = attempt.autoSubmitReason || attempt.auto_submit_reason;
    const response = {
      status: attempt.status,
      autoSubmitReason: reason ?? null,
    };

    if (['exam_replaced', 'exam_ended'].includes(reason)) {
      const resRow = await query('SELECT * FROM results WHERE exam_attempt_id = @attemptId', { attemptId });
      if (resRow.recordset.length > 0) {
        const r = mapRow(resRow.recordset[0]);
        response.result = {
          score: Number(r.score),
          correctCount: r.correctCount ?? r.correct_count,
          totalQuestions: r.totalQuestions ?? r.total_questions,
          passed: Boolean(r.passed),
        };
      }
    }
    return response;
  },

  async recordLeave(userId, attemptId) {
    const { attempt } = await resolveAttemptContext(userId, attemptId);
    if (attempt.status === ATTEMPT_STATUS.IN_PROGRESS) {
      await query(
        `UPDATE exam_attempts SET leave_count = leave_count + 1 WHERE id = @id AND status = 'in_progress'`,
        { id: attemptId }
      );
    }
    return { attemptId };
  },

  async submitAttempt(userId, attemptId, answersPayload, autoSubmitReason = null) {
    const { exam, attempt } = await resolveAttemptContext(userId, attemptId);
    return gradeAndSubmitAttempt({ attempt, exam, answersPayload, autoSubmitReason });
  },

  async getCandidateRoleOptions(examCandidateId) {
    const candRes = await query('SELECT * FROM exam_candidates WHERE id = @id', { id: examCandidateId });
    const examCandidate = mapRow(candRes.recordset[0]);
    if (!examCandidate) throw new ApiError(404, 'Không tìm thấy thí sinh', 'CANDIDATE_NOT_FOUND');

    const examRes = await query('SELECT * FROM exams WHERE id = @id', { id: examCandidate.examId || examCandidate.exam_id });
    const exam = mapRow(examRes.recordset[0]);

    const empRes = await query('SELECT * FROM employees WHERE id = @id', { id: examCandidate.employeeId || examCandidate.employee_id });
    const employee = mapRow(empRes.recordset[0]);

    const codeId = examCandidate.examCodeId || examCandidate.exam_code_id;
    const codeRes = await query('SELECT department_id FROM exam_codes WHERE id = @id', { id: codeId });
    const examCode = mapRow(codeRes.recordset[0]);

    const options = await getEmployeeRoleOptions(employee, exam);
    const inProgRes = await query(
      `SELECT COUNT(1) AS count FROM exam_attempts WHERE exam_candidate_id = @candId AND status = 'in_progress'`,
      { candId: examCandidateId }
    );
    const hasInProgress = (inProgRes.recordset[0]?.count ?? 0) > 0;

    return {
      examCandidateId: String(examCandidate.id),
      currentDepartmentId: examCode?.department_id ? String(examCode.department_id) : null,
      allowCommonCompensation: isCommonCompensationEnabled(exam),
      hasInProgress,
      options: options.map((o) => ({
        departmentId: o.departmentId,
        name: o.name,
        code: o.code,
        isMain: o.isMain,
        eligible: o.eligible,
        deptQuestionCount: o.deptQuestionCount ?? 0,
        requiredDeptQuestions: o.requiredDeptQuestions ?? 0,
      })),
    };
  },

  async grantExtraAttempt(examCandidateId, leaderUserId, { departmentId } = {}) {
    const candRes = await query(
      `SELECT ec.*, e.fullname AS employee_fullname, e.id AS emp_id
       FROM exam_candidates ec
       JOIN employees e ON ec.employee_id = e.id
       WHERE ec.id = @id`,
      { id: examCandidateId }
    );
    const examCandidate = mapRow(candRes.recordset[0]);
    if (!examCandidate) throw new ApiError(404, 'Không tìm thấy thí sinh trong kỳ thi này', 'CANDIDATE_NOT_FOUND');

    const examRes = await query('SELECT * FROM exams WHERE id = @id', { id: examCandidate.exam_id || examCandidate.examId });
    const exam = mapRow(examRes.recordset[0]);
    if (exam.status !== EXAM_STATUS.PUBLISHED) {
      throw new ApiError(400, 'Chỉ có thể cấp lại lượt thi cho kỳ thi đang đăng chính thức', 'EXAM_INVALID_STATUS');
    }

    let roleChanged = false;
    let roleName = null;
    if (departmentId) {
      const empRes = await query('SELECT * FROM employees WHERE id = @id', { id: examCandidate.emp_id });
      const employee = mapRow(empRes.recordset[0]);

      const inProg = await query(
        `SELECT COUNT(1) AS count FROM exam_attempts WHERE exam_candidate_id = @id AND status = 'in_progress'`,
        { id: examCandidateId }
      );
      if ((inProg.recordset[0]?.count ?? 0) > 0) {
        throw new ApiError(400, 'Thí sinh đang có lượt thi dở dang, không thể đổi vai trò.', 'ROLE_CHANGE_BLOCKED');
      }

      const resAssign = await assignCandidateRole({ exam, examCandidate, employee, departmentId });
      roleChanged = resAssign.changed;
      await query(
        `UPDATE exam_candidates SET role_chosen_by = '${ROLE_CHOSEN_BY.LEADER}', role_confirmed_at = SYSUTCDATETIME() WHERE id = @id`,
        { id: examCandidateId }
      );
      const options = await getEmployeeRoleOptions(employee, exam);
      roleName = options.find((o) => String(o.departmentId) === String(departmentId))?.name ?? null;
    }

    const updRes = await query(
      `UPDATE exam_candidates 
       SET extra_attempts_granted = extra_attempts_granted + 1, updated_at = SYSUTCDATETIME()
       OUTPUT INSERTED.* WHERE id = @id`,
      { id: examCandidateId }
    );
    const granted = mapRow(updRes.recordset[0]);

    return {
      examCandidateId: String(examCandidate.id),
      employeeName: examCandidate.employee_fullname ?? null,
      examId: String(exam.id),
      examTitle: exam.title,
      extraAttemptsGranted: granted.extra_attempts_granted,
      maxAttempts: resolveMaxAttempts(granted),
      roleChanged,
      roleName,
      grantedBy: leaderUserId,
    };
  },
};

async function finalizeInProgressAttempts(examIds, autoSubmitReason, attemptFilter = {}) {
  if (!examIds?.length) return { finalized: 0, failed: 0 };

  const inClauses = examIds.map((_, i) => `@e_${i}`);
  const eParams = Object.fromEntries(examIds.map((id, i) => [`e_${i}`, id]));

  const examsRes = await query(`SELECT * FROM exams WHERE id IN (${inClauses.join(',')})`, eParams);
  const examById = new Map(examsRes.recordset.map((e) => [String(e.id), mapRow(e)]));

  let where = `WHERE ec.exam_id IN (${inClauses.join(',')}) AND ea.attempt_type = 'official' AND ea.status = 'in_progress'`;
  if (attemptFilter.abandoned) {
    where += ` AND (ea.last_active_at < DATEADD(millisecond, -@window, SYSUTCDATETIME()) OR ea.expires_at < DATEADD(millisecond, -@window, SYSUTCDATETIME()))`;
    eParams.window = ABANDONED_ATTEMPT_WINDOW_MS;
  }

  const attRes = await query(
    `SELECT ea.*, ec.exam_id
     FROM exam_attempts ea
     JOIN exam_candidates ec ON ea.exam_candidate_id = ec.id
     ${where}`,
    eParams
  );
  const attempts = mapRows(attRes.recordset);

  let finalized = 0;
  let failed = 0;

  for (const attempt of attempts) {
    const exam = examById.get(String(attempt.exam_id || attempt.examId));
    if (!exam) continue;
    try {
      await gradeAndSubmitAttempt({ attempt, exam, autoSubmitReason });
      finalized += 1;
    } catch (err) {
      failed += 1;
      console.error(`finalize attempt (${autoSubmitReason}) failed:`, attempt.id, err.message);
    }
  }

  return { finalized, failed };
}

export function finalizeAttemptsForReplacedExams(examIds) {
  return finalizeInProgressAttempts(examIds, 'exam_replaced');
}

export function finalizeAttemptsForEndedExams(examIds) {
  return finalizeInProgressAttempts(examIds, 'exam_ended');
}

export async function finalizeAbandonedAttempts() {
  const expiredCandRes = await query(
    `SELECT DISTINCT ec.exam_id FROM exam_attempts ea
     JOIN exam_candidates ec ON ea.exam_candidate_id = ec.id
     WHERE ea.attempt_type = 'official' AND ea.status = 'in_progress'
       AND (ea.last_active_at < DATEADD(millisecond, -@w, SYSUTCDATETIME()) OR ea.expires_at < DATEADD(millisecond, -@w, SYSUTCDATETIME()))`,
    { w: ABANDONED_ATTEMPT_WINDOW_MS }
  );
  const examIds = expiredCandRes.recordset.map((r) => String(r.exam_id));
  return finalizeInProgressAttempts(examIds, 'inactive_timeout', { abandoned: true });
}
