/**
 * Service Phân tích: (1) chất lượng câu hỏi thi chính thức, (2) bản đồ năng lực theo chủ đề.
 * Chỉ ĐỌC dữ liệu sẵn có (CandidateAnswer, Result, ExamAttempt, PracticeSession...), không đổi schema.
 * Các hàm tính toán (computeQuestionStats, tallyByTopic, buildTopicCompetency, pickWeakest, detectAnomalies, buildPracticeReadiness)
 * là hàm thuần để test được không cần DB — xem server/test/test-analytics.mjs.
 */

import { query as rawQuery } from '../db/sql-helpers.js';
const query = async (text, params) => (await rawQuery(text, params)).recordset ?? [];
import {
  ATTEMPT_STATUS,
  ATTEMPT_TYPE,
  EXAM_STATUS,
  QUESTION_USAGE,
} from '../models/constants.js';
import { ApiError } from '../utils/api-error.js';

// ── Ngưỡng (đổi ở đây, không rải trong code) ──
const MIN_RESPONSES = 5; // dưới ngưỡng: "chưa đủ dữ liệu", không hiện chỉ số
const RELIABLE_RESPONSES = 30; // từ ngưỡng này mới gắn cờ (độ phân biệt cần mẫu đủ lớn)
const MIN_TOPIC_ANSWERS = 5; // chủ đề có ít hơn số câu này: chưa đủ dữ liệu
const MIN_DEPT_CANDIDATES = 3; // phòng ban ít hơn số người này: ẩn toàn bộ số liệu (bảo vệ cá nhân)
const MIN_PRACTICE_ANSWERS = 5; // sẵn sàng thi: số câu ôn tập (đúng chủ đề kỳ thi) thí sinh phải thực sự làm; nộp bài trống không tính
const WEAK_BELOW = 0.7; // tỷ lệ đúng dưới mức này = chủ đề yếu (khớp điểm đạt mặc định 70%)
const TOO_EASY = 0.95;
const TOO_HARD = 0.1;
const LOW_DISCRIMINATION = 0.2;
const SUSPECT_DISCRIMINATION = -0.2; // nhóm điểm cao đúng ít hơn nhóm thấp rõ rệt -> nghi sai đáp án
const UNKNOWN_TOPIC = 'Chưa phân loại';

// ── Ngưỡng phát hiện bất thường (chỉ là gợi ý để xem xét, không kết luận gian lận) ──
const MIN_ATTEMPTS_FOR_PAIRS = 10; // kỳ thi ít hơn số lượt này: không so cặp (mẫu quá nhỏ, dễ báo nhầm)
const MIN_SHARED_WRONG = 5; // số câu cùng chọn đúng một đáp án sai tối thiểu để nêu cặp
const SHARED_WRONG_RATIO = 0.6; // ...và chiếm từ tỷ lệ này trong số câu sai của người sai ít hơn
const POPULAR_DISTRACTOR = 0.3; // đáp án sai có > 30% người chọn là "bẫy phổ biến": trùng nhau không có ý nghĩa
const FAST_SEC_PER_QUESTION = 8; // trung bình dưới số giây này cho mỗi câu đã trả lời = quá nhanh
const MIN_ANSWERED_FOR_SPEED = 10; // dưới số câu này không xét tốc độ
const MIN_LEAVES = 3; // rời màn hình thi từ số lần này trở lên mới nêu (1-2 lần dễ do thao tác vô ý)

const sid = (v) => (v != null ? String(v) : '');

/**
 * Mức độ sẵn sàng thi: mỗi phòng ban có bao nhiêu thí sinh (trong `employees`) nằm trong `practicedUserIds`.
 * Hàm thuần (không đụng DB). Phòng ban dưới `minCandidates` người: ẩn số liệu như department-competency.
 */
export function buildPracticeReadiness(employees, practicedUserIds, deptNames, minCandidates) {
  const done = new Set(practicedUserIds.map(sid));
  const byDept = new Map();
  for (const e of employees) {
    const key = sid(e.departmentId);
    const d = byDept.get(key) ?? { candidates: 0, practiced: 0 };
    d.candidates += 1;
    if (done.has(sid(e.userId))) d.practiced += 1;
    byDept.set(key, d);
  }
  return [...byDept]
    .map(([departmentId, { candidates, practiced }]) => {
      const base = { departmentId, name: deptNames.get(departmentId) ?? departmentId, candidates };
      return candidates < minCandidates
        ? { ...base, insufficientData: true, practiced: null, rate: null }
        : { ...base, insufficientData: false, practiced, rate: ratio(practiced, candidates) };
    })
    .sort((a, b) => a.name.localeCompare(b.name, 'vi'));
}
const round2 = (n) => Math.round(n * 100) / 100;
const ratio = (num, den) => (den > 0 ? round2(num / den) : null);

// ───────────────────────── 1) Phân tích câu hỏi (hàm thuần) ─────────────────────────

/**
 * @param responses [{ attemptId, score, questionId, selectedAnswerIds: string[], isCorrect }]
 * @param questions Map questionId -> { content, topicId, difficulty, scope, answerType }
 * @param options   Map questionId -> [{ answerId, content, isCorrect }]
 */
export function computeQuestionStats(responses, questions, options) {
  const byQuestion = new Map();
  for (const r of responses) {
    if (!byQuestion.has(r.questionId)) byQuestion.set(r.questionId, []);
    byQuestion.get(r.questionId).push(r);
  }

  const items = [];
  for (const [questionId, rows] of byQuestion) {
    const meta = questions.get(questionId) ?? {};
    const n = rows.length;
    const base = {
      questionId,
      content: meta.content,
      topicId: meta.topicId ? sid(meta.topicId) : null,
      difficulty: meta.difficulty,
      scope: meta.scope,
      answerType: meta.answerType,
      responses: n,
    };

    if (n < MIN_RESPONSES) {
      items.push({
        ...base,
        insufficientData: true,
        reliability: 'low',
        correctRate: null,
        discrimination: null,
        flags: [],
        options: [],
      });
      continue;
    }

    // Nhóm cao/thấp = nửa trên/nửa dưới theo điểm tổng của CHÍNH những người làm câu này
    // (mỗi người một bộ câu riêng nên không có bảng xếp hạng chung). Đồng điểm: tách theo attemptId.
    // ponytail: điểm tổng có chứa chính câu này (chưa loại ra), đủ dùng khi bài ≥ 20 câu.
    const sorted = [...rows].sort((a, b) => b.score - a.score || (a.attemptId < b.attemptId ? -1 : 1));
    const half = Math.floor(n / 2);
    const upper = sorted.slice(0, half);
    const lower = sorted.slice(n - half);
    const rate = (group, pred) => group.filter(pred).length / group.length;

    const correctRate = round2(rows.filter((r) => r.isCorrect).length / n);
    const discrimination = round2(rate(upper, (r) => r.isCorrect) - rate(lower, (r) => r.isCorrect));
    const reliability = n >= RELIABLE_RESPONSES ? 'ok' : 'low';

    const picked = (group, answerId) => rate(group, (r) => r.selectedAnswerIds.includes(answerId));
    const optionStats = (options.get(questionId) ?? []).map((o) => ({
      answerId: o.answerId,
      content: o.content,
      isCorrect: o.isCorrect,
      selectedRate: round2(picked(rows, o.answerId)),
      upperRate: round2(picked(upper, o.answerId)),
      lowerRate: round2(picked(lower, o.answerId)),
    }));

    const flags = [];
    if (reliability === 'ok') {
      const tooEasy = correctRate >= TOO_EASY;
      const tooHard = correctRate <= TOO_HARD;
      if (tooEasy) flags.push('too_easy');
      if (tooHard) flags.push('too_hard');
      if (discrimination <= SUSPECT_DISCRIMINATION) flags.push('suspect_key');
      else if (!tooEasy && !tooHard && discrimination < LOW_DISCRIMINATION) flags.push('low_discrimination');
      if (
        (meta.difficulty === 'hard' && correctRate >= 0.85) ||
        (meta.difficulty === 'easy' && correctRate <= 0.4)
      ) {
        flags.push('difficulty_mismatch');
      }
    }

    items.push({ ...base, insufficientData: false, reliability, correctRate, discrimination, flags, options: optionStats });
  }
  return items;
}

// ───/ ───────────────────────── 2) Năng lực theo chủ đề (hàm thuần) ─────────────────────────

/** rows: [{ topicId, source: 'official'|'practice', correct: boolean }] -> Map topicId -> {official, practice} */
export function tallyByTopic(rows) {
  const tally = new Map();
  for (const r of rows) {
    if (!tally.has(r.topicId)) {
      tally.set(r.topicId, { official: { total: 0, correct: 0 }, practice: { total: 0, correct: 0 } });
    }
    const bucket = tally.get(r.topicId)[r.source];
    bucket.total += 1;
    if (r.correct) bucket.correct += 1;
  }
  return tally;
}

export function buildTopicCompetency(tally, topicNames) {
  const out = [];
  for (const [topicId, t] of tally) {
    const total = t.official.total + t.practice.total;
    const correct = t.official.correct + t.practice.correct;
    const insufficientData = total < MIN_TOPIC_ANSWERS;
    out.push({
      topicId,
      name: topicNames.get(topicId) ?? UNKNOWN_TOPIC,
      total,
      rate: insufficientData ? null : ratio(correct, total),
      insufficientData,
      official: { total: t.official.total, rate: ratio(t.official.correct, t.official.total) },
      practice: { total: t.practice.total, rate: ratio(t.practice.correct, t.practice.total) },
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name, 'vi'));
}

export function pickWeakest(topics, limit = 3) {
  return topics
    .filter((t) => !t.insufficientData && t.rate < WEAK_BELOW)
    .sort((a, b) => a.rate - b.rate)
    .slice(0, limit);
}

// ───────────────────────── 3) Phát hiện bất thường (hàm thuần) ─────────────────────────

/**
 * Chỉ nêu dấu hiệu để Người duyệt đề xem xét, không kết luận gian lận.
 * So đáp án theo MÃ đáp án (không theo vị trí A/B/C) nên việc xáo riêng từng lượt thi không che được trùng lặp.
 * @param attempts  [{ attemptId, employeeId, startedAt, submittedAt, leaveCount? }] (đã loại bài bị hệ thống tự nộp)
 * @param responses [{ attemptId, questionId, selectedAnswerIds: string[], isCorrect }]
 */
export function detectAnomalies(attempts, responses) {
  const stat = new Map(); // attemptId -> { answered, wrong }
  const responders = new Map(); // questionId -> số người đã trả lời
  const groups = new Map(); // "câu|tập đáp án sai" -> { questionId, attemptIds }
  for (const r of responses) {
    if (!r.selectedAnswerIds.length) continue;
    responders.set(r.questionId, (responders.get(r.questionId) ?? 0) + 1);
    const s = stat.get(r.attemptId) ?? { answered: 0, wrong: 0 };
    s.answered += 1;
    stat.set(r.attemptId, s);
    if (r.isCorrect) continue;
    s.wrong += 1;
    const key = `${r.questionId}|${[...r.selectedAnswerIds].sort().join(',')}`;
    if (!groups.has(key)) groups.set(key, { questionId: r.questionId, attemptIds: [] });
    groups.get(key).attemptIds.push(r.attemptId);
  }

  const employeeOf = new Map(attempts.map((a) => [a.attemptId, a.employeeId]));
  const sharedWrong = [];
  if (attempts.length >= MIN_ATTEMPTS_FOR_PAIRS) {
    const pairs = new Map(); // "a|b" -> số câu cùng sai giống nhau
    for (const g of groups.values()) {
      const ids = g.attemptIds;
      if (ids.length < 2 || ids.length / responders.get(g.questionId) > POPULAR_DISTRACTOR) continue;
      for (let i = 0; i < ids.length; i++) {
        for (let j = i + 1; j < ids.length; j++) {
          if (employeeOf.get(ids[i]) === employeeOf.get(ids[j])) continue; // cùng một người thi nhiều lượt
          const key = ids[i] < ids[j] ? `${ids[i]}|${ids[j]}` : `${ids[j]}|${ids[i]}`;
          pairs.set(key, (pairs.get(key) ?? 0) + 1);
        }
      }
    }
    for (const [key, shared] of pairs) {
      const [a, b] = key.split('|');
      const base = Math.min(stat.get(a).wrong, stat.get(b).wrong);
      if (shared >= MIN_SHARED_WRONG && shared / base >= SHARED_WRONG_RATIO) {
        sharedWrong.push({ attemptIds: [a, b], shared, ofWrong: base });
      }
    }
    sharedWrong.sort((x, y) => y.shared - x.shared || y.shared / y.ofWrong - x.shared / x.ofWrong);
  }

  const fast = [];
  for (const a of attempts) {
    const answered = stat.get(a.attemptId)?.answered ?? 0;
    if (answered < MIN_ANSWERED_FOR_SPEED || !a.startedAt || !a.submittedAt) continue;
    const totalSeconds = Math.round((new Date(a.submittedAt) - new Date(a.startedAt)) / 1000);
    const secondsPerQuestion = round2(totalSeconds / answered);
    if (secondsPerQuestion < FAST_SEC_PER_QUESTION) {
      fast.push({ attemptId: a.attemptId, totalSeconds, answered, secondsPerQuestion });
    }
  }
  fast.sort((x, y) => x.secondsPerQuestion - y.secondsPerQuestion);

  const leaves = attempts
    .filter((a) => (a.leaveCount ?? 0) >= MIN_LEAVES)
    .map((a) => ({ attemptId: a.attemptId, leaveCount: a.leaveCount }))
    .sort((x, y) => y.leaveCount - x.leaveCount);

  return { sharedWrong, fast, leaves };
}

// ───────────────────────── Helper SQL DB ─────────────────────────

const assertId = (value, name) => {
  if (value && typeof value !== 'string' && typeof value !== 'number') {
    throw new ApiError(400, `${name} không hợp lệ`, 'INVALID_ID');
  }
};

const topicNameMap = async () => {
  const rows = await query('SELECT id, name FROM topics');
  return new Map(rows.map((t) => [sid(t.id), t.name]));
};

export const analyticsService = {
  /** Người ra đề: chất lượng từng câu hỏi, chỉ từ kỳ thi chính thức. */
  async getQuestionAnalysis({ examId, topicId } = {}) {
    assertId(examId, 'examId');
    assertId(topicId, 'topicId');

    // Lấy tất cả lượt thi chính thức submitted không bị auto submit
    let attemptSql = `
      SELECT ea.id, ea.exam_candidate_id, r.score
      FROM exam_attempts ea
      JOIN results r ON r.exam_attempt_id = ea.id
      JOIN exam_candidates ec ON ec.id = ea.exam_candidate_id
      WHERE ea.attempt_type = @attemptType
        AND ea.status = @status
        AND ea.auto_submit_reason IS NULL
    `;
    const params = {
      attemptType: ATTEMPT_TYPE.OFFICIAL,
      status: ATTEMPT_STATUS.SUBMITTED,
    };
    if (examId) {
      attemptSql += ' AND ec.exam_id = @examId';
      params.examId = examId;
    }

    const usableAttempts = await query(attemptSql, params);
    const usable = usableAttempts.map((a) => ({
      id: sid(a.id),
      score: Number(a.score),
    }));
    const ids = usable.map((a) => a.id);

    if (ids.length === 0) {
      return {
        meta: { attemptsAnalyzed: 0, minResponses: MIN_RESPONSES, reliableResponses: RELIABLE_RESPONSES },
        items: [],
      };
    }

    // Lấy câu trả lời của các lượt thi
    const answerSql = `
      SELECT ca.id, ca.exam_attempt_id, ca.question_id, ca.is_correct,
             cas.answer_id
      FROM candidate_answers ca
      JOIN exam_attempts ea ON ea.id = ca.exam_attempt_id
      JOIN exam_candidates ec ON ec.id = ea.exam_candidate_id
      LEFT JOIN candidate_answer_selections cas ON cas.candidate_answer_id = ca.id
      WHERE ea.attempt_type = @attemptType
        AND ea.status = @status
        AND ea.auto_submit_reason IS NULL
        ${examId ? 'AND ec.exam_id = @examId' : ''}
    `;
    const answerRows = await query(answerSql, params);

    // Group answer rows by ca.id
    const responseMap = new Map();
    for (const r of answerRows) {
      const caId = sid(r.id);
      if (!responseMap.has(caId)) {
        responseMap.set(caId, {
          attemptId: sid(r.exam_attempt_id),
          questionId: sid(r.question_id),
          isCorrect: Boolean(r.is_correct),
          selectedAnswerIds: [],
        });
      }
      if (r.answer_id) {
        responseMap.get(caId).selectedAnswerIds.push(sid(r.answer_id));
      }
    }

    const scoreByAttempt = new Map(usable.map((a) => [a.id, a.score]));
    const responses = [...responseMap.values()]
      .filter((a) => scoreByAttempt.has(a.attemptId))
      .map((a) => ({
        ...a,
        score: scoreByAttempt.get(a.attemptId),
      }));

    const questionIds = [...new Set(responses.map((r) => r.questionId))];
    let questions = new Map();
    let options = new Map();

    if (questionIds.length > 0) {
      const qRows = await query('SELECT id, content, topic_id, difficulty, scope, answer_type FROM questions');
      for (const q of qRows) {
        if (questionIds.includes(sid(q.id))) {
          questions.set(sid(q.id), {
            id: sid(q.id),
            content: q.content,
            topicId: q.topic_id ? sid(q.topic_id) : null,
            difficulty: q.difficulty,
            scope: q.scope,
            answerType: q.answer_type,
          });
        }
      }

      const ansRows = await query('SELECT id, question_id, content, is_correct, sort_order FROM answers ORDER BY sort_order ASC');
      for (const a of ansRows) {
        const qid = sid(a.question_id);
        if (questionIds.includes(qid)) {
          if (!options.has(qid)) options.set(qid, []);
          options.get(qid).push({
            answerId: sid(a.id),
            content: a.content,
            isCorrect: Boolean(a.is_correct),
          });
        }
      }
    }

    const names = await topicNameMap();
    const weight = (i) => (i.insufficientData ? 3 : i.flags.includes('suspect_key') ? 0 : i.flags.length ? 1 : 2);
    const items = computeQuestionStats(responses, questions, options)
      .filter((i) => !topicId || i.topicId === sid(topicId))
      .map((i) => ({ ...i, topicName: names.get(i.topicId) ?? UNKNOWN_TOPIC }))
      .sort((a, b) => weight(a) - weight(b) || b.responses - a.responses);

    return {
      meta: {
        attemptsAnalyzed: usable.length,
        minResponses: MIN_RESPONSES,
        reliableResponses: RELIABLE_RESPONSES,
      },
      items,
    };
  },

  /** Thí sinh: năng lực của CHÍNH MÌNH (thi chính thức + luyện tập). */
  async getMyCompetency(userId) {
    const empRows = await query('SELECT id FROM employees WHERE user_id = @userId', { userId });
    const employeeId = empRows.length > 0 ? sid(empRows[0].id) : null;

    let officialRows = [];
    if (employeeId) {
      const rows = await query(`
        SELECT ca.question_id, ca.is_correct, ea.auto_submit_reason,
               (SELECT COUNT(*) FROM candidate_answer_selections cas WHERE cas.candidate_answer_id = ca.id) as selection_count
        FROM candidate_answers ca
        JOIN exam_attempts ea ON ea.id = ca.exam_attempt_id
        JOIN exam_candidates ec ON ec.id = ea.exam_candidate_id
        WHERE ec.employee_id = @employeeId
          AND ea.attempt_type = @attemptType
          AND ea.status = @status
      `, {
        employeeId,
        attemptType: ATTEMPT_TYPE.OFFICIAL,
        status: ATTEMPT_STATUS.SUBMITTED,
      });

      for (const r of rows) {
        const blank = Number(r.selection_count) === 0;
        if (r.auto_submit_reason && blank) continue;
        officialRows.push({
          questionId: sid(r.question_id),
          correct: Boolean(r.is_correct),
        });
      }
    }

    // Practice questions
    const practiceRows = await query(`
      SELECT pq.question_id, pq.checked, pq.is_correct,
             (SELECT COUNT(*) FROM practice_question_selected_answers psa WHERE psa.practice_question_id = pq.id) as sel_count
      FROM practice_questions pq
      JOIN practice_sessions ps ON ps.id = pq.practice_session_id
      WHERE ps.user_id = @userId AND ps.status = 'submitted'
    `, { userId });

    const practice = practiceRows
      .filter((q) => Boolean(q.checked) || Number(q.sel_count) > 0)
      .map((q) => ({
        questionId: sid(q.question_id),
        correct: Boolean(q.is_correct),
      }));

    const allQIds = [...new Set([...officialRows, ...practice].map((r) => r.questionId))];
    const topicByQ = new Map();
    if (allQIds.length > 0) {
      const qDocs = await query('SELECT id, topic_id FROM questions');
      for (const q of qDocs) {
        if (allQIds.includes(sid(q.id))) {
          topicByQ.set(sid(q.id), q.topic_id ? sid(q.topic_id) : null);
        }
      }
    }

    const allRows = [
      ...officialRows.map((r) => ({ topicId: topicByQ.get(r.questionId), source: 'official', correct: r.correct })),
      ...practice.map((r) => ({ topicId: topicByQ.get(r.questionId), source: 'practice', correct: r.correct })),
    ].filter((r) => r.topicId);

    const topicNames = await topicNameMap();
    const topics = buildTopicCompetency(tallyByTopic(allRows), topicNames);
    const weakestTopics = pickWeakest(topics);

    return {
      summary: {
        totalAnswered: allRows.length,
        officialAnswered: officialRows.length,
        practiceAnswered: practice.length,
      },
      topics,
      weakestTopics,
    };
  },

  /** Người duyệt đề: năng lực theo từng PHÒNG BAN (chỉ từ kỳ thi chính thức). */
  async getDepartmentCompetency({ examId } = {}) {
    assertId(examId, 'examId');

    const params = {
      attemptType: ATTEMPT_TYPE.OFFICIAL,
      status: ATTEMPT_STATUS.SUBMITTED,
    };
    let sql = `
      SELECT ea.id, ea.department_id, ec.employee_id, ca.question_id, ca.is_correct, ea.auto_submit_reason,
             (SELECT COUNT(*) FROM candidate_answer_selections cas WHERE cas.candidate_answer_id = ca.id) as selection_count
      FROM candidate_answers ca
      JOIN exam_attempts ea ON ea.id = ca.exam_attempt_id
      JOIN exam_candidates ec ON ec.id = ea.exam_candidate_id
      WHERE ea.attempt_type = @attemptType
        AND ea.status = @status
    `;
    if (examId) {
      sql += ' AND ec.exam_id = @examId';
      params.examId = examId;
    }

    const rows = await query(sql, params);

    // Lọc bỏ bài auto submit bị blank
    const validRows = [];
    const peopleByDept = new Map(); // deptId -> Set<employeeId>
    for (const r of rows) {
      const dept = sid(r.department_id);
      const emp = sid(r.employee_id);
      if (!peopleByDept.has(dept)) peopleByDept.set(dept, new Set());
      peopleByDept.get(dept).add(emp);

      const blank = Number(r.selection_count) === 0;
      if (r.auto_submit_reason && blank) continue;
      validRows.push({
        deptId: dept,
        questionId: sid(r.question_id),
        correct: Boolean(r.is_correct),
      });
    }

    const qIds = [...new Set(validRows.map((r) => r.questionId))];
    const topicByQ = new Map();
    if (qIds.length > 0) {
      const qDocs = await query('SELECT id, topic_id FROM questions');
      for (const q of qDocs) {
        if (qIds.includes(sid(q.id))) {
          topicByQ.set(sid(q.id), q.topic_id ? sid(q.topic_id) : null);
        }
      }
    }

    const rowsByDept = new Map();
    for (const r of validRows) {
      const topicId = topicByQ.get(r.questionId);
      if (!r.deptId || !topicId) continue;
      if (!rowsByDept.has(r.deptId)) rowsByDept.set(r.deptId, []);
      rowsByDept.get(r.deptId).push({ topicId, source: 'official', correct: r.correct });
    }

    const deptRows = await query('SELECT id, name FROM departments');
    const deptNames = new Map(deptRows.map((d) => [sid(d.id), d.name]));
    const topicNames = await topicNameMap();

    const departments = [...peopleByDept].map(([departmentId, people]) => {
      const base = { departmentId, name: deptNames.get(departmentId) ?? departmentId, candidates: people.size };
      if (people.size < MIN_DEPT_CANDIDATES) {
        return { ...base, insufficientData: true, overallRate: null, topics: [] };
      }
      const deptData = rowsByDept.get(departmentId) ?? [];
      const topics = buildTopicCompetency(tallyByTopic(deptData), topicNames).map((t) => ({
        topicId: t.topicId,
        name: t.name,
        total: t.total,
        rate: t.rate,
        insufficientData: t.insufficientData,
      }));
      const overallRate = deptData.length < MIN_TOPIC_ANSWERS ? null : ratio(deptData.filter((r) => r.correct).length, deptData.length);
      return { ...base, insufficientData: false, overallRate, topics };
    });

    departments.sort((a, b) => a.name.localeCompare(b.name, 'vi'));
    return { minCandidates: MIN_DEPT_CANDIDATES, departments };
  },

  /**
   * Người duyệt đề: mức độ sẵn sàng của kỳ thi ĐANG PHÁT HÀNH (chỉ có tối đa 1 kỳ thi published).
   * Mẫu số = thí sinh của kỳ thi đó; tử số = người đã nộp ít nhất 1 bài luyện tập CÓ chủ đề của kỳ thi.
   */
  async getPracticeReadiness() {
    const examRows = await query(`
      SELECT id, title, topic_id, start_date, end_date
      FROM exams
      WHERE status = @status
    `, { status: EXAM_STATUS.PUBLISHED });

    if (examRows.length === 0) {
      return { minCandidates: MIN_DEPT_CANDIDATES, exam: null, departments: [] };
    }
    const exam = examRows[0];
    const examTopicId = sid(exam.topic_id);

    // Ngân hàng ôn tập của chủ đề kỳ thi
    const practiceQuestions = await query(`
      SELECT id FROM questions
      WHERE topic_id = @topicId
        AND is_active = 1
        AND (usage = @usagePractice OR usage IS NULL)
    `, {
      topicId: examTopicId,
      usagePractice: QUESTION_USAGE.PRACTICE,
    });
    const topicQuestionIds = practiceQuestions.map((q) => sid(q.id));

    // Thí sinh của kỳ thi
    const candidateEmployees = await query(`
      SELECT e.id as employee_id, e.department_id, e.user_id
      FROM exam_candidates ec
      JOIN employees e ON e.id = ec.employee_id
      WHERE ec.exam_id = @examId AND e.is_active = 1
    `, { examId: exam.id });

    // Đếm câu đã làm thuộc chủ đề thi
    let practicedUserIds = [];
    if (topicQuestionIds.length > 0) {
      const practicedRows = await query(`
        SELECT ps.user_id, COUNT(*) as answered
        FROM practice_questions pq
        JOIN practice_sessions ps ON ps.id = pq.practice_session_id
        WHERE ps.status = 'submitted'
          AND pq.question_id IN (
            SELECT id FROM questions
            WHERE topic_id = @topicId
              AND is_active = 1
              AND (usage = @usagePractice OR usage IS NULL)
          )
          AND (pq.checked = 1 OR EXISTS (
            SELECT 1 FROM practice_question_selected_answers psa
            WHERE psa.practice_question_id = pq.id
          ))
        GROUP BY ps.user_id
        HAVING COUNT(*) >= @minAnswers
      `, {
        topicId: examTopicId,
        usagePractice: QUESTION_USAGE.PRACTICE,
        minAnswers: MIN_PRACTICE_ANSWERS,
      });
      practicedUserIds = practicedRows.map((r) => sid(r.user_id));
    }

    const deptRows = await query('SELECT id, name FROM departments');
    const deptNames = new Map(deptRows.map((d) => [sid(d.id), d.name]));

    const topicRows = await query('SELECT name FROM topics WHERE id = @id', { id: examTopicId });
    const topicName = topicRows.length > 0 ? topicRows[0].name : '';

    const employees = candidateEmployees.map((e) => ({
      departmentId: sid(e.department_id),
      userId: sid(e.user_id),
    }));

    return {
      minCandidates: MIN_DEPT_CANDIDATES,
      exam: {
        title: exam.title,
        topicName,
        startDate: exam.start_date,
        endDate: exam.end_date,
        practiceQuestionCount: topicQuestionIds.length,
        minAnswers: MIN_PRACTICE_ANSWERS,
      },
      departments: buildPracticeReadiness(employees, practicedUserIds, deptNames, MIN_DEPT_CANDIDATES),
    };
  },

  /**
   * Người duyệt đề: dấu hiệu bất thường theo từng kỳ thi.
   */
  async getAnomalies({ examId } = {}) {
    assertId(examId, 'examId');

    let attemptSql = `
      SELECT ea.id, ea.exam_candidate_id, ea.department_id, ea.started_at, ea.submitted_at, ea.leave_count,
             ec.exam_id, ec.employee_id, e.fullname, e.employee_code
      FROM exam_attempts ea
      JOIN exam_candidates ec ON ec.id = ea.exam_candidate_id
      JOIN employees e ON e.id = ec.employee_id
      WHERE ea.attempt_type = @attemptType
        AND ea.status = @status
        AND ea.auto_submit_reason IS NULL
    `;
    const params = {
      attemptType: ATTEMPT_TYPE.OFFICIAL,
      status: ATTEMPT_STATUS.SUBMITTED,
    };
    if (examId) {
      attemptSql += ' AND ec.exam_id = @examId';
      params.examId = examId;
    }

    const usable = await query(attemptSql, params);

    // Lấy đáp án của các lượt thi usable
    let answers = [];
    if (usable.length > 0) {
      const ansSql = `
        SELECT ca.id, ca.exam_attempt_id, ca.question_id, ca.is_correct,
               cas.answer_id
        FROM candidate_answers ca
        JOIN exam_attempts ea ON ea.id = ca.exam_attempt_id
        JOIN exam_candidates ec ON ec.id = ea.exam_candidate_id
        LEFT JOIN candidate_answer_selections cas ON cas.candidate_answer_id = ca.id
        WHERE ea.attempt_type = @attemptType
          AND ea.status = @status
          AND ea.auto_submit_reason IS NULL
          ${examId ? 'AND ec.exam_id = @examId' : ''}
      `;
      const ansRows = await query(ansSql, params);

      const respMap = new Map();
      for (const r of ansRows) {
        const caId = sid(r.id);
        if (!respMap.has(caId)) {
          respMap.set(caId, {
            examAttemptId: sid(r.exam_attempt_id),
            questionId: sid(r.question_id),
            isCorrect: Boolean(r.is_correct),
            selectedAnswerIds: [],
          });
        }
        if (r.answer_id) {
          respMap.get(caId).selectedAnswerIds.push(sid(r.answer_id));
        }
      }
      answers = [...respMap.values()];
    }

    const who = (a) => ({
      attemptId: sid(a.id),
      name: a.fullname ?? null,
      code: a.employee_code ?? null,
    });

    const byExam = new Map();
    for (const a of usable) {
      const k = sid(a.exam_id);
      if (!byExam.has(k)) byExam.set(k, []);
      byExam.get(k).push(a);
    }

    const keys = [...byExam.keys()];
    let examDocs = [];
    if (examId) {
      examDocs = await query('SELECT id, title, status, start_date, end_date, published_at, created_at FROM exams WHERE id = @examId', { examId });
    } else {
      examDocs = await query('SELECT id, title, status, start_date, end_date, published_at, created_at FROM exams');
    }

    const docById = new Map(examDocs.map((e) => [sid(e.id), e]));
    const meta = (id) => {
      const d = docById.get(id);
      return {
        title: d?.title ?? id,
        running: d?.status === EXAM_STATUS.PUBLISHED,
        endsAt: d?.end_date ?? d?.published_at ?? d?.start_date ?? d?.created_at ?? null,
      };
    };

    const exams = [];
    for (const [id, list] of byExam) {
      const ids = new Set(list.map((a) => sid(a.id)));
      const responses = answers
        .filter((r) => ids.has(sid(r.examAttemptId)))
        .map((r) => ({
          attemptId: sid(r.examAttemptId),
          questionId: sid(r.questionId),
          selectedAnswerIds: (r.selectedAnswerIds ?? []).map(sid),
          isCorrect: Boolean(r.isCorrect),
        }));

      const found = detectAnomalies(
        list.map((a) => ({
          attemptId: sid(a.id),
          employeeId: sid(a.employee_id),
          startedAt: a.started_at,
          submittedAt: a.submitted_at,
          leaveCount: a.leave_count ?? 0,
        })),
        responses
      );
      const byAttempt = new Map(list.map((a) => [sid(a.id), a]));
      exams.push({
        examId: id,
        ...meta(id),
        attempts: list.length,
        sharedWrong: found.sharedWrong.map((p) => ({
          people: p.attemptIds.map((x) => who(byAttempt.get(x))),
          shared: p.shared,
          ofWrong: p.ofWrong,
        })),
        fast: found.fast.map((f) => ({ ...who(byAttempt.get(f.attemptId)), ...f })),
        leaves: found.leaves.map((l) => ({ ...who(byAttempt.get(l.attemptId)), ...l })),
      });
    }

    if (!examId) {
      for (const d of examDocs) {
        const id = sid(d.id);
        if (d.status === EXAM_STATUS.PUBLISHED && !byExam.has(id)) {
          exams.push({ examId: id, ...meta(id), attempts: 0, sharedWrong: [], fast: [], leaves: [] });
        }
      }
    }

    const time = (e) => (e.endsAt ? new Date(e.endsAt).getTime() : 0);
    exams.sort((a, b) => Number(b.running) - Number(a.running) || time(b) - time(a));

    return {
      thresholds: {
        minAttemptsForPairs: MIN_ATTEMPTS_FOR_PAIRS,
        minSharedWrong: MIN_SHARED_WRONG,
        sharedWrongRatio: SHARED_WRONG_RATIO,
        fastSecPerQuestion: FAST_SEC_PER_QUESTION,
        minAnsweredForSpeed: MIN_ANSWERED_FOR_SPEED,
        minLeaves: MIN_LEAVES,
      },
      exams,
    };
  },
};
