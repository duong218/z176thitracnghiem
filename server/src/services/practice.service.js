/**
 * Service Luyện tập theo chủ đề (Practice) - Triển khai SQL Server.
 * Câu hỏi CHỈ lấy từ ngân hàng ÔN TẬP (usage = 'practice'), gồm câu chung và câu riêng phòng ban.
 * Kết quả luyện tập lưu riêng ở các bảng practice_sessions, practice_questions, v.v.
 */

import { query, withTransaction, mapRow, mapRows } from '../db/sql-helpers.js';
import { EXAM_STATUS, QUESTION_SCOPE, QUESTION_USAGE } from '../models/constants.js';
import { ApiError } from '../utils/api-error.js';

const MAX_QUESTIONS = 30;
const DIFFICULTY_VALUES = new Set(['all', 'easy', 'medium', 'hard']);
const MODE_VALUES = new Set(['instant', 'exam']);
const TIME_GRACE_SEC = 15;

async function getCandidateDepartmentIds(userId) {
  const empRes = await query('SELECT id, department_id FROM employees WHERE user_id = @userId', { userId });
  if (empRes.recordset.length === 0) return [];
  const emp = empRes.recordset[0];
  const ids = [];
  if (emp.department_id) ids.push(String(emp.department_id));

  const extraRes = await query('SELECT department_id FROM employee_extra_departments WHERE employee_id = @empId', { empId: emp.id });
  for (const r of extraRes.recordset) {
    if (r.department_id) ids.push(String(r.department_id));
  }
  return [...new Set(ids)];
}

function normalizeStartOptions(options = {}) {
  const topicIds = Array.isArray(options.topicIds) ? options.topicIds.filter(Boolean).map(String) : [];
  if (topicIds.length === 0) {
    throw new ApiError(400, 'Vui lòng chọn ít nhất một chủ đề', 'PRACTICE_TOPIC_REQUIRED');
  }

  const questionCount = Math.min(Math.max(parseInt(options.questionCount, 10) || 10, 1), MAX_QUESTIONS);
  const timeLimitMin = Math.max(parseInt(options.timeLimitMin, 10) || 0, 0);
  const difficulty = DIFFICULTY_VALUES.has(options.difficulty) ? options.difficulty : 'all';
  const mode = MODE_VALUES.has(options.mode) ? options.mode : 'exam';

  return { topicIds, questionCount, timeLimitMin, difficulty, mode };
}

function isSameAnswerSet(correctSet, selectedIds) {
  const selected = new Set(selectedIds.map(String));
  return (
    correctSet.size > 0 &&
    selected.size > 0 &&
    selected.size === correctSet.size &&
    [...selected].every((id) => correctSet.has(id))
  );
}

function shuffle(list) {
  const arr = [...list];
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function isTimeUp(session) {
  const timeLimitSec = session.timeLimitSec ?? session.time_limit_sec;
  if (!timeLimitSec) return false;
  const startedAt = session.startedAt || session.started_at;
  return Date.now() > new Date(startedAt).getTime() + (timeLimitSec + TIME_GRACE_SEC) * 1000;
}

export function markExamTopic(topics, examTopicId) {
  const key = examTopicId ? String(examTopicId) : null;
  return topics
    .map((t) => ({ ...t, isExamTopic: key !== null && String(t.id) === key }))
    .sort((a, b) => Number(b.isExamTopic) - Number(a.isExamTopic));
}

export async function getAvailableTopics(userId) {
  const topicsRes = await query('SELECT id, name FROM topics WHERE is_active = 1 ORDER BY name ASC');
  const topics = topicsRes.recordset;
  if (topics.length === 0) return [];

  const examRes = await query(`SELECT TOP 1 topic_id FROM exams WHERE status = '${EXAM_STATUS.PUBLISHED}'`);
  const activeExamTopicId = examRes.recordset[0]?.topic_id;

  const departmentIds = await getCandidateDepartmentIds(userId);
  if (departmentIds.length === 0) return [];

  const inDeptClauses = departmentIds.map((_, i) => `@d_${i}`);
  const params = Object.fromEntries(departmentIds.map((id, i) => [`d_${i}`, id]));

  const countRes = await query(
    `SELECT topic_id, COUNT(1) AS count FROM questions
     WHERE is_active = 1 AND usage = 'practice'
       AND (scope = 'Common' OR (scope = 'DepartmentSpecific' AND department_id IN (${inDeptClauses.join(',')})))
     GROUP BY topic_id`,
    params
  );
  const countByTopic = new Map(countRes.recordset.map((c) => [String(c.topic_id), c.count]));

  return markExamTopic(
    topics
      .filter((t) => (countByTopic.get(String(t.id)) ?? 0) > 0)
      .map((t) => ({ id: String(t.id), name: t.name, availableCount: countByTopic.get(String(t.id)) })),
    activeExamTopicId
  );
}

export async function startPractice(userId, rawOptions) {
  const { topicIds, questionCount, timeLimitMin, difficulty, mode } = normalizeStartOptions(rawOptions);
  const departmentIds = await getCandidateDepartmentIds(userId);
  if (departmentIds.length === 0) throw new ApiError(400, 'Tài khoản chưa gắn phòng ban', 'PRACTICE_NO_DEPARTMENT');

  const inTopicClauses = topicIds.map((_, i) => `@t_${i}`);
  const inDeptClauses = departmentIds.map((_, i) => `@d_${i}`);
  const params = {};
  topicIds.forEach((id, i) => { params[`t_${i}`] = id; });
  departmentIds.forEach((id, i) => { params[`d_${i}`] = id; });

  let diffClause = '';
  if (difficulty && difficulty !== 'all') {
    diffClause = ' AND q.difficulty = @difficulty';
    params.difficulty = difficulty;
  }

  const sampleRes = await query(
    `SELECT TOP (@qCount) q.id, q.content, q.answer_type, q.image_url
     FROM questions q
     WHERE q.is_active = 1 AND q.usage = 'practice'
       AND q.topic_id IN (${inTopicClauses.join(',')})
       AND (q.scope = 'Common' OR (q.scope = 'DepartmentSpecific' AND q.department_id IN (${inDeptClauses.join(',')})))
       ${diffClause}
     ORDER BY NEWID()`,
    { ...params, qCount: questionCount }
  );

  const sampled = sampleRes.recordset;
  if (sampled.length === 0) throw new ApiError(400, 'Chưa có câu hỏi phù hợp cho lựa chọn này', 'PRACTICE_NO_QUESTIONS');

  const qIds = sampled.map((q) => q.id);
  const inQClauses = qIds.map((_, i) => `@qid_${i}`);
  const qParams = Object.fromEntries(qIds.map((id, i) => [`qid_${i}`, id]));

  const ansRes = await query(
    `SELECT id, question_id, content, is_correct, sort_order
     FROM answers WHERE question_id IN (${inQClauses.join(',')})
     ORDER BY sort_order ASC`,
    qParams
  );

  const answersByQuestion = new Map();
  for (const a of ansRes.recordset) {
    const k = String(a.question_id);
    const list = answersByQuestion.get(k) ?? [];
    list.push(a);
    answersByQuestion.set(k, list);
  }

  const questions = sampled.filter((q) =>
    (answersByQuestion.get(String(q.id)) ?? []).some((a) => a.is_correct)
  );
  if (questions.length === 0) throw new ApiError(400, 'Chưa có câu hỏi phù hợp cho lựa chọn này', 'PRACTICE_NO_QUESTIONS');

  const orderedByQuestion = new Map(
    questions.map((q) => [String(q.id), shuffle(answersByQuestion.get(String(q.id)))])
  );

  // Đổi các session in_progress cũ sang expired
  await query(`UPDATE practice_sessions SET status = 'expired', updated_at = SYSUTCDATETIME() WHERE user_id = @userId AND status = 'in_progress'`, { userId });

  const totalQuestions = questions.length;
  const timeLimitSec = timeLimitMin * 60;

  const insSession = await query(
    `INSERT INTO practice_sessions (user_id, difficulty, mode, total_questions, time_limit_sec, status)
     OUTPUT INSERTED.*
     VALUES (@userId, @difficulty, @mode, @totalQuestions, @timeLimitSec, 'in_progress')`,
    { userId, difficulty, mode, totalQuestions, timeLimitSec }
  );
  const session = mapRow(insSession.recordset[0]);

  for (const tId of topicIds) {
    await query('INSERT INTO practice_session_topics (practice_session_id, topic_id) VALUES (@sId, @tId)', { sId: session.id, tId });
  }

  for (let index = 0; index < questions.length; index++) {
    const q = questions[index];
    const qk = String(q.id);
    const insPQ = await query(
      `INSERT INTO practice_questions (practice_session_id, question_id, order_index)
       OUTPUT INSERTED.id
       VALUES (@sId, @qid, @orderIndex)`,
      { sId: session.id, qid: q.id, orderIndex: index }
    );
    const pqId = insPQ.recordset[0].id;

    const orderedOpts = orderedByQuestion.get(qk);
    for (let oIdx = 0; oIdx < orderedOpts.length; oIdx++) {
      await query(
        `INSERT INTO practice_question_options (practice_question_id, answer_id, order_index)
         VALUES (@pqId, @ansId, @sortOrder)`,
        { pqId, ansId: orderedOpts[oIdx].id, sortOrder: oIdx }
      );
    }

    const correctAns = answersByQuestion.get(qk).filter((a) => a.is_correct);
    for (const ca of correctAns) {
      await query(
        `INSERT INTO practice_question_correct_answers (practice_question_id, answer_id) VALUES (@pqId, @ansId)`,
        { pqId, ansId: ca.id }
      );
    }
  }

  return {
    sessionId: String(session.id),
    mode: session.mode,
    availableCount: questions.length,
    timeLimitSec: session.timeLimitSec,
    questions: questions.map((q) => ({
      id: String(q.id),
      content: q.content,
      answerType: q.answer_type,
      imageUrl: q.image_url || null,
      answers: orderedByQuestion.get(String(q.id)).map((a) => ({ id: String(a.id), content: a.content })),
    })),
  };
}

export async function checkPracticeAnswer(userId, sessionId, questionId, selectedAnswerIds = []) {
  const sessRes = await query('SELECT * FROM practice_sessions WHERE id = @id AND user_id = @userId', { id: sessionId, userId });
  const session = mapRow(sessRes.recordset[0]);
  if (!session) throw new ApiError(404, 'Không tìm thấy lượt luyện', 'PRACTICE_NOT_FOUND');
  if (session.status !== 'in_progress') throw new ApiError(400, 'Lượt luyện đã kết thúc', 'PRACTICE_ALREADY_SUBMITTED');
  if (session.mode !== 'instant') throw new ApiError(400, 'Lượt luyện này không hỗ trợ kiểm tra từng câu', 'PRACTICE_MODE_NOT_INSTANT');
  if (isTimeUp(session)) throw new ApiError(400, 'Đã hết thời gian làm bài', 'PRACTICE_TIME_UP');

  const pqRes = await query(
    `SELECT pq.id, pq.checked, pq.is_correct
     FROM practice_questions pq
     WHERE pq.practice_session_id = @sId AND pq.question_id = @qid`,
    { sId: sessionId, qid: questionId }
  );
  const item = mapRow(pqRes.recordset[0]);
  if (!item) throw new ApiError(404, 'Câu hỏi không thuộc lượt luyện này', 'PRACTICE_QUESTION_NOT_IN_SESSION');

  const corRes = await query(
    'SELECT answer_id FROM practice_question_correct_answers WHERE practice_question_id = @pqId',
    { pqId: item.id }
  );
  const correctIds = corRes.recordset.map((r) => String(r.answer_id));

  if (item.checked) {
    const selRes = await query(
      'SELECT answer_id FROM practice_question_selected_answers WHERE practice_question_id = @pqId',
      { pqId: item.id }
    );
    return {
      questionId,
      isCorrect: Boolean(item.isCorrect || item.is_correct),
      selectedAnswerIds: selRes.recordset.map((r) => String(r.answer_id)),
      correctAnswerIds: correctIds,
    };
  }

  const ids = [...new Set((Array.isArray(selectedAnswerIds) ? selectedAnswerIds : []).map(String))];
  if (ids.length === 0) throw new ApiError(400, 'Vui lòng chọn ít nhất một đáp án', 'PRACTICE_NO_SELECTION');
  const isCorrect = isSameAnswerSet(new Set(correctIds), ids);

  await query(
    `UPDATE practice_questions
     SET is_correct = @isCorrect, checked = 1
     WHERE id = @pqId AND checked = 0`,
    { isCorrect: isCorrect ? 1 : 0, pqId: item.id }
  );

  for (const aId of ids) {
    await query(
      'INSERT INTO practice_question_selected_answers (practice_question_id, answer_id) VALUES (@pqId, @aId)',
      { pqId: item.id, aId }
    );
  }

  return {
    questionId,
    isCorrect,
    selectedAnswerIds: ids,
    correctAnswerIds: correctIds,
  };
}

function buildSubmitResult(session) {
  const total = session.total_questions ?? session.totalQuestions ?? 0;
  const correct = session.correct_count ?? session.correctCount ?? 0;
  return {
    sessionId: String(session.id),
    totalQuestions: total,
    correctCount: correct,
    percent: total > 0 ? Math.round((correct / total) * 100) : 0,
  };
}

export async function submitPractice(userId, sessionId, answers = []) {
  const sessRes = await query('SELECT * FROM practice_sessions WHERE id = @id AND user_id = @userId', { id: sessionId, userId });
  const session = mapRow(sessRes.recordset[0]);
  if (!session) throw new ApiError(404, 'Không tìm thấy lượt luyện', 'PRACTICE_NOT_FOUND');
  if (session.status === 'submitted') return buildSubmitResult(session);
  if (session.status !== 'in_progress') {
    throw new ApiError(400, 'Lượt luyện này đã bị hủy hoặc thay bằng lượt mới', 'PRACTICE_SESSION_EXPIRED');
  }

  const answerByQuestion = new Map(
    (Array.isArray(answers) ? answers : []).map((a) => [String(a.questionId), [...new Set((a.selectedAnswerIds || []).map(String))]])
  );

  const pqRes = await query(
    'SELECT id, question_id, checked FROM practice_questions WHERE practice_session_id = @sId',
    { sId: sessionId }
  );
  const items = pqRes.recordset;

  let correctCount = 0;
  for (const item of items) {
    const qid = String(item.question_id);
    const corRes = await query(
      'SELECT answer_id FROM practice_question_correct_answers WHERE practice_question_id = @pqId',
      { pqId: item.id }
    );
    const correctIds = corRes.recordset.map((r) => String(r.answer_id));

    let selected = [];
    if (item.checked) {
      const selRes = await query(
        'SELECT answer_id FROM practice_question_selected_answers WHERE practice_question_id = @pqId',
        { pqId: item.id }
      );
      selected = selRes.recordset.map((r) => String(r.answer_id));
    } else {
      selected = answerByQuestion.get(qid) ?? [];
      await query('DELETE FROM practice_question_selected_answers WHERE practice_question_id = @pqId', { pqId: item.id });
      for (const aId of selected) {
        await query(
          'INSERT INTO practice_question_selected_answers (practice_question_id, answer_id) VALUES (@pqId, @aId)',
          { pqId: item.id, aId }
        );
      }
    }

    const isCorrect = isSameAnswerSet(new Set(correctIds), selected);
    if (isCorrect) correctCount += 1;

    await query(
      'UPDATE practice_questions SET is_correct = @isCorrect, checked = 1 WHERE id = @pqId',
      { isCorrect: isCorrect ? 1 : 0, pqId: item.id }
    );
  }

  await query(
    `UPDATE practice_sessions
     SET status = 'submitted', correct_count = @correctCount, submitted_at = SYSUTCDATETIME(), updated_at = SYSUTCDATETIME()
     WHERE id = @id`,
    { correctCount, id: sessionId }
  );

  session.totalQuestions = items.length;
  session.correctCount = correctCount;
  return buildSubmitResult(session);
}

export async function getActivePractice(userId) {
  const sessRes = await query(
    `SELECT TOP 1 * FROM practice_sessions WHERE user_id = @userId AND status = 'in_progress' ORDER BY started_at DESC`,
    { userId }
  );
  const session = mapRow(sessRes.recordset[0]);
  if (!session) return null;

  const pqRes = await query(
    `SELECT pq.id AS pq_id, pq.question_id, pq.checked, pq.is_correct,
            q.content, q.answer_type, q.image_url
     FROM practice_questions pq
     JOIN questions q ON pq.question_id = q.id
     WHERE pq.practice_session_id = @sId
     ORDER BY pq.order_index ASC`,
    { sId: session.id }
  );
  const items = pqRes.recordset;

  if (isTimeUp(session)) {
    const lockedAnswers = {};
    for (const item of items) {
      if (item.checked) {
        const selRes = await query('SELECT answer_id FROM practice_question_selected_answers WHERE practice_question_id = @pqId', { pqId: item.pq_id });
        lockedAnswers[String(item.question_id)] = selRes.recordset.map((r) => String(r.answer_id));
      }
    }
    return {
      sessionId: String(session.id),
      timedOut: true,
      questionIds: items.map((i) => String(i.question_id)),
      answers: lockedAnswers,
    };
  }

  const selected = {};
  const checked = {};
  const clientQuestions = [];

  for (const item of items) {
    const qk = String(item.question_id);
    const selRes = await query('SELECT answer_id FROM practice_question_selected_answers WHERE practice_question_id = @pqId', { pqId: item.pq_id });
    const selIds = selRes.recordset.map((r) => String(r.answer_id));
    if (selIds.length > 0) selected[qk] = selIds;

    if (item.checked) {
      const corRes = await query('SELECT answer_id FROM practice_question_correct_answers WHERE practice_question_id = @pqId', { pqId: item.pq_id });
      checked[qk] = {
        isCorrect: Boolean(item.is_correct),
        selectedAnswerIds: selIds,
        correctAnswerIds: corRes.recordset.map((r) => String(r.answer_id)),
      };
    }

    const optRes = await query(
      `SELECT a.id, a.content
       FROM practice_question_options pqo
       JOIN answers a ON pqo.answer_id = a.id
       WHERE pqo.practice_question_id = @pqId
       ORDER BY pqo.order_index ASC`,
      { pqId: item.pq_id }
    );
    clientQuestions.push({
      id: qk,
      content: item.content,
      answerType: item.answer_type,
      imageUrl: item.image_url || null,
      answers: optRes.recordset.map((a) => ({ id: String(a.id), content: a.content })),
    });
  }

  return {
    sessionId: String(session.id),
    mode: session.mode,
    timeLimitSec: session.timeLimitSec,
    startedAt: session.startedAt,
    questions: clientQuestions,
    selected,
    checked,
  };
}

export async function abandonPractice(userId, sessionId) {
  const upd = await query(
    `UPDATE practice_sessions SET status = 'expired', updated_at = SYSUTCDATETIME()
     OUTPUT INSERTED.id WHERE id = @id AND user_id = @userId AND status = 'in_progress'`,
    { id: sessionId, userId }
  );
  if (upd.recordset.length === 0) throw new ApiError(404, 'Không tìm thấy lượt luyện đang làm', 'PRACTICE_NOT_FOUND');
  return { abandoned: true };
}

export async function getPracticeProgress(userId) {
  const sessRes = await query(
    `SELECT ps.id, ps.total_questions, ps.correct_count, ps.submitted_at
     FROM practice_sessions ps
     WHERE ps.user_id = @userId AND ps.status = 'submitted'
     ORDER BY ps.submitted_at DESC`,
    { userId }
  );
  const sessions = sessRes.recordset;

  let totalQuestions = 0;
  let totalCorrect = 0;
  for (const s of sessions) {
    totalQuestions += s.total_questions ?? 0;
    totalCorrect += s.correct_count ?? 0;
  }

  const topicStatsRes = await query(
    `SELECT t.id AS topic_id, t.name AS topic_name,
            COUNT(pq.id) AS total_q,
            SUM(CASE WHEN pq.is_correct = 1 THEN 1 ELSE 0 END) AS correct_q
     FROM practice_questions pq
     JOIN practice_sessions ps ON pq.practice_session_id = ps.id
     JOIN questions q ON pq.question_id = q.id
     JOIN topics t ON q.topic_id = t.id
     WHERE ps.user_id = @userId AND ps.status = 'submitted'
     GROUP BY t.id, t.name`,
    { userId }
  );

  const topics = topicStatsRes.recordset.map((r) => {
    const tq = r.total_q ?? 0;
    const cq = r.correct_q ?? 0;
    return {
      id: String(r.topic_id),
      name: r.topic_name,
      questions: tq,
      correct: cq,
      percent: tq > 0 ? Math.round((cq / tq) * 100) : 0,
    };
  }).sort((a, b) => a.percent - b.percent);

  return {
    totalSessions: sessions.length,
    totalQuestions,
    averagePercent: totalQuestions > 0 ? Math.round((totalCorrect / totalQuestions) * 100) : 0,
    topics,
    recent: sessions.slice(0, 10).map((s) => ({
      id: String(s.id),
      topics: [],
      totalQuestions: s.total_questions,
      correctCount: s.correct_count,
      percent: s.total_questions > 0 ? Math.round((s.correct_count / s.total_questions) * 100) : 0,
      submittedAt: s.submitted_at,
    })),
  };
}

function computeStreakDays(submittedDates) {
  if (submittedDates.length === 0) return 0;
  const toDayKey = (d) => {
    const x = new Date(d);
    x.setHours(0, 0, 0, 0);
    return x.getTime();
  };
  const uniqueDays = [...new Set(submittedDates.map(toDayKey))].sort((a, b) => b - a);
  const today = toDayKey(new Date());
  const oneDayMs = 24 * 60 * 60 * 1000;

  if (uniqueDays[0] !== today && uniqueDays[0] !== today - oneDayMs) return 0;

  let streak = 1;
  for (let i = 1; i < uniqueDays.length; i += 1) {
    if (uniqueDays[i - 1] - uniqueDays[i] === oneDayMs) streak += 1;
    else break;
  }
  return streak;
}

const BADGE_DEFS = [
  { id: 'questions_50', label: 'Chăm chỉ khởi đầu', desc: 'Hoàn thành 50 câu luyện tập', check: (st) => st.totalQuestions >= 50 },
  { id: 'questions_200', label: 'Bền bỉ', desc: 'Hoàn thành 200 câu luyện tập', check: (st) => st.totalQuestions >= 200 },
  { id: 'questions_500', label: 'Kiên trì vượt trội', desc: 'Hoàn thành 500 câu luyện tập', check: (st) => st.totalQuestions >= 500 },
  { id: 'sessions_10', label: 'Luyện tập đều đặn', desc: 'Hoàn thành 10 bài luyện tập', check: (st) => st.totalSessions >= 10 },
  { id: 'sessions_30', label: 'Ôn tập chuyên cần', desc: 'Hoàn thành 30 bài luyện tập', check: (st) => st.totalSessions >= 30 },
  { id: 'streak_3', label: 'Duy trì 3 ngày', desc: 'Luyện tập 3 ngày liên tiếp', check: (st) => st.streakDays >= 3 },
  { id: 'streak_7', label: 'Duy trì 1 tuần', desc: 'Luyện tập 7 ngày liên tiếp', check: (st) => st.streakDays >= 7 },
  {
    id: 'topic_master',
    label: 'Nắm vững chủ đề',
    desc: 'Một chủ đề đạt từ 90% đúng trở lên (tối thiểu 20 câu)',
    check: (st) => st.topics.some((t) => t.questions >= 20 && t.percent >= 90),
  },
];

function buildEncouragement({ streakDays, totalSessions, weakest }) {
  if (totalSessions === 0) return 'Bắt đầu buổi luyện tập đầu tiên của bạn nhé.';
  if (streakDays >= 7) return `Bạn đã duy trì ${streakDays} ngày liên tiếp, rất đáng ghi nhận!`;
  if (streakDays >= 3) return `Bạn đang luyện tập đều đặn ${streakDays} ngày liên tiếp, cố gắng giữ nhịp này nhé.`;
  if (weakest && weakest.percent < 70) return `Bạn đã tiến bộ nhiều rồi, thử ôn thêm chủ đề "${weakest.name}" nhé.`;
  return 'Cảm ơn bạn đã dành thời gian ôn luyện, cố gắng phát huy nhé.';
}

export async function getPracticeAchievements(userId) {
  const progress = await getPracticeProgress(userId);
  const subRes = await query(
    `SELECT submitted_at FROM practice_sessions WHERE user_id = @userId AND status = 'submitted'`,
    { userId }
  );
  const streakDays = computeStreakDays(subRes.recordset.map((s) => s.submitted_at).filter(Boolean));

  const stats = {
    totalQuestions: progress.totalQuestions,
    totalSessions: progress.totalSessions,
    streakDays,
    topics: progress.topics,
  };

  const badges = BADGE_DEFS.filter((b) => b.check(stats)).map((b) => ({
    id: b.id,
    label: b.label,
    desc: b.desc,
  }));

  const weakest = progress.topics[0];
  const message = buildEncouragement({ streakDays, totalSessions: progress.totalSessions, weakest });

  return { streakDays, badges, message };
}
