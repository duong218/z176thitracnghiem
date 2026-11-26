/**
 * Service Quản lý Ngân hàng Câu hỏi & Import Excel (Question Service) - Triển khai SQL Server.
 * Xử lý: CRUD câu hỏi & đáp án, Upload/Xóa ảnh Cloudinary, Preview & Xác nhận Import Excel/Word, và Thống kê cơ cấu câu hỏi.
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import XLSX from 'xlsx';
import mammoth from 'mammoth';
import { v2 as cloudinary } from 'cloudinary';
import {
  ANSWER_TYPE,
  DIFFICULTY,
  QUESTION_KIND,
  QUESTION_SCOPE,
  EXAM_STATUS,
  QUESTION_USAGE,
} from '../models/constants.js';
import { query, withTransaction, mapRow, mapRows } from '../db/sql-helpers.js';
import { ApiError, assertFound } from '../utils/api-error.js';
import { findDepartmentByCode, upsertDepartmentForImport } from './department.service.js';
import { normalizeDeptName } from '../utils/normalize-dept.js';
import { findOrCreateTopicByName } from './topic.service.js';
import { env } from '../config/env.js';

cloudinary.config({
  cloud_name: env.cloudinary.cloudName,
  api_key: env.cloudinary.apiKey,
  api_secret: env.cloudinary.apiSecret,
});

const CLOUDINARY_QUESTION_FOLDER = 'z176/questions';

function uploadBufferToCloudinary(buffer, publicId) {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      { public_id: publicId, overwrite: true, resource_type: 'image' },
      (err, result) => (err ? reject(err) : resolve(result)),
    );
    stream.end(buffer);
  });
}

export async function uploadQuestionImageBuffer(buffer) {
  const hash = crypto.createHash('sha256').update(buffer).digest('hex');
  const publicId = `${CLOUDINARY_QUESTION_FOLDER}/${hash}`;
  const result = await uploadBufferToCloudinary(buffer, publicId);
  return { imageUrl: result.secure_url, imageCloudinaryId: result.public_id };
}

async function deleteQuestionImage(publicId) {
  if (!publicId) return;
  try {
    await cloudinary.uploader.destroy(publicId, { resource_type: 'image' });
  } catch (err) {
    console.error('Cloudinary destroy thất bại:', publicId, err.message);
  }
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

function normalizeContentForDedupe(content) {
  return String(content ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

function buildNormalizedMap(pairs) {
  const out = {};
  for (const [rawKeys, value] of pairs) {
    for (const k of rawKeys) {
      out[normalizeKey(k)] = value;
    }
  }
  return out;
}

const DIFFICULTY_MAP = buildNormalizedMap([
  [['easy', 'dễ', 'de'], DIFFICULTY.EASY],
  [['medium', 'trung bình', 'trung binh', 'tb'], DIFFICULTY.MEDIUM],
  [['hard', 'khó', 'kho'], DIFFICULTY.HARD],
]);

const KIND_MAP = buildNormalizedMap([
  [['theory', 'lý thuyết', 'ly thuyet'], QUESTION_KIND.THEORY],
  [['practice', 'bài tập', 'bai tap'], QUESTION_KIND.PRACTICE],
]);

const ANSWER_TYPE_MAP = buildNormalizedMap([
  [['single', 'single choice', 'chọn 1', 'chon 1'], ANSWER_TYPE.SINGLE],
  [['multiple', 'multiple choice', 'chọn nhiều', 'chon nhieu'], ANSWER_TYPE.MULTIPLE],
]);

const SCOPE_MAP = buildNormalizedMap([
  [['common', 'chung'], QUESTION_SCOPE.COMMON],
  [['departmentspecific', 'department', 'riêng', 'rieng'], QUESTION_SCOPE.DEPARTMENT_SPECIFIC],
]);

function mapRowKeys(row) {
  const out = {};
  for (const [k, v] of Object.entries(row)) {
    out[normalizeKey(k)] = v;
  }
  return out;
}

function parseCorrectIndices(raw) {
  if (raw == null || raw === '') return [];
  const s = String(raw).trim();
  const parts = s.split(/[,;|/]/).map((p) => p.trim()).filter(Boolean);
  const indices = [];
  for (const p of parts) {
    const n = Number.parseInt(p, 10);
    if (!Number.isNaN(n) && n >= 1) {
      indices.push(n);
    }
  }
  return [...new Set(indices)];
}

export function validateAnswerSet(answerType, answers) {
  if (!Array.isArray(answers) || answers.length < 2) {
    throw new ApiError(400, 'Cần ít nhất 2 phương án trả lời', 'QUESTION_ANSWERS_MIN');
  }
  const correct = answers.filter((a) => a.isCorrect);
  if (answerType === ANSWER_TYPE.SINGLE && correct.length !== 1) {
    throw new ApiError(400, 'Câu single choice cần đúng 1 đáp án đúng', 'QUESTION_SINGLE_CORRECT');
  }
  if (answerType === ANSWER_TYPE.MULTIPLE && correct.length < 1) {
    throw new ApiError(400, 'Câu multiple choice cần ít nhất 1 đáp án đúng', 'QUESTION_MULTI_CORRECT');
  }
}

export function parseUsage(raw, { required = false } = {}) {
  if (raw === undefined || raw === null || raw === '') {
    if (required) {
      throw new ApiError(
        400,
        'Vui lòng chọn nhập vào ngân hàng thi chính thức hay ngân hàng ôn tập',
        'QUESTION_USAGE_REQUIRED',
      );
    }
    return undefined;
  }
  if (!Object.values(QUESTION_USAGE).includes(raw)) {
    throw new ApiError(400, 'usage không hợp lệ', 'QUESTION_VALIDATION');
  }
  return raw;
}

function serializeQuestion(doc, answers) {
  return {
    id: String(doc.id || doc._id),
    _id: String(doc.id || doc._id),
    content: doc.content,
    questionKind: doc.questionKind || doc.question_kind,
    answerType: doc.answerType || doc.answer_type,
    difficulty: doc.difficulty,
    scope: doc.scope,
    usage: doc.usage ?? QUESTION_USAGE.EXAM,
    topicId: doc.topicId ? String(doc.topicId) : (doc.topic_id ? String(doc.topic_id) : undefined),
    departmentId: doc.departmentId ? String(doc.departmentId) : (doc.department_id ? String(doc.department_id) : undefined),
    imageUrl: doc.imageUrl || doc.image_url,
    imageCloudinaryId: doc.imageCloudinaryId || doc.image_cloudinary_id,
    isActive: Boolean(doc.isActive !== undefined ? doc.isActive : doc.is_active),
    createdAt: doc.createdAt || doc.created_at,
    updatedAt: doc.updatedAt || doc.updated_at,
    answers: (answers || []).map((a) => ({
      id: String(a.id || a._id),
      _id: String(a.id || a._id),
      content: a.content,
      isCorrect: Boolean(a.isCorrect !== undefined ? a.isCorrect : a.is_correct),
      sortOrder: a.sortOrder ?? a.sort_order ?? 0,
    })),
  };
}

function buildSqlWhere(filters = {}) {
  const { topicId, scope, departmentId, questionKind, difficulty, answerType, usage, isActive = true, search } = filters;
  let where = 'WHERE 1=1';
  const params = {};

  if (isActive !== undefined && isActive !== 'all') {
    where += ' AND q.is_active = @isActive';
    params.isActive = (isActive === true || isActive === 'true') ? 1 : 0;
  }
  if (topicId) {
    where += ' AND q.topic_id = @topicId';
    params.topicId = topicId;
  }
  if (scope) {
    where += ' AND q.scope = @scope';
    params.scope = scope;
  }
  if (departmentId) {
    where += ' AND q.department_id = @deptId';
    params.deptId = departmentId;
  }
  if (questionKind) {
    where += ' AND q.question_kind = @kind';
    params.kind = questionKind;
  }
  if (difficulty) {
    where += ' AND q.difficulty = @difficulty';
    params.difficulty = difficulty;
  }
  if (answerType) {
    where += ' AND q.answer_type = @answerType';
    params.answerType = answerType;
  }
  const usageValue = parseUsage(usage);
  if (usageValue) {
    where += ' AND q.usage = @usage';
    params.usage = usageValue;
  }
  if (search?.trim()) {
    where += ' AND q.content LIKE @search';
    params.search = `%${search.trim()}%`;
  }
  return { where, params };
}

export async function listQuestions(filters = {}) {
  const { page = 1, limit = 20 } = filters;
  const safeLimit = Math.min(Math.max(Number(limit) || 20, 1), 100);
  const safePage = Math.max(Number(page) || 1, 1);
  const offset = (safePage - 1) * safeLimit;

  const { where, params } = buildSqlWhere(filters);
  const queryParams = { ...params, limit: safeLimit, offset };

  const countRes = await query(`SELECT COUNT(1) AS total FROM questions q ${where}`, params);
  const total = countRes.recordset[0]?.total ?? 0;

  // Đếm theo từng ngân hàng
  const baseFilters = { ...filters, usage: undefined };
  const baseSql = buildSqlWhere(baseFilters);
  const examCountRes = await query(`SELECT COUNT(1) AS count FROM questions q ${baseSql.where} AND q.usage = 'exam'`, baseSql.params);
  const practiceCountRes = await query(`SELECT COUNT(1) AS count FROM questions q ${baseSql.where} AND q.usage = 'practice'`, baseSql.params);

  const dataRes = await query(
    `SELECT q.* FROM questions q ${where}
     ORDER BY q.updated_at DESC
     OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY`,
    queryParams
  );
  const items = dataRes.recordset;

  let answersByQ = new Map();
  if (items.length > 0) {
    const qIds = items.map((q) => q.id);
    const ansParams = {};
    const inClauses = qIds.map((id, idx) => {
      ansParams[`qid_${idx}`] = id;
      return `@qid_${idx}`;
    });
    const ansRes = await query(
      `SELECT * FROM answers WHERE question_id IN (${inClauses.join(',')}) ORDER BY sort_order ASC`,
      ansParams
    );
    for (const a of ansRes.recordset) {
      const key = String(a.question_id);
      if (!answersByQ.has(key)) answersByQ.set(key, []);
      answersByQ.get(key).push(a);
    }
  }

  return {
    items: items.map((q) => serializeQuestion(mapRow(q), answersByQ.get(String(q.id)) ?? [])),
    pagination: { page: safePage, limit: safeLimit, total },
    usageCounts: {
      exam: examCountRes.recordset[0]?.count ?? 0,
      practice: practiceCountRes.recordset[0]?.count ?? 0,
    },
  };
}

export async function getQuestionById(id) {
  const res = await query('SELECT * FROM questions WHERE id = @id', { id });
  const question = mapRow(res.recordset[0]);
  assertFound(question, 'Không tìm thấy câu hỏi', 'QUESTION_NOT_FOUND');

  const ansRes = await query('SELECT * FROM answers WHERE question_id = @id ORDER BY sort_order ASC', { id });
  return serializeQuestion(question, ansRes.recordset.map(mapRow));
}

// Giữ nguyên mã đáp án cũ khi sửa: bài đang thi / lịch sử thi tham chiếu answer_id
async function replaceAnswers(questionId, answersInput) {
  await withTransaction(async (txQuery) => {
    const oldRes = await txQuery(
      'SELECT id, content FROM answers WHERE question_id = @questionId ORDER BY sort_order ASC',
      { questionId }
    );
    const unused = [...oldRes.recordset];
    const take = (index) => (index >= 0 ? unused.splice(index, 1)[0].id : null);
    // Ưu tiên khớp đúng nội dung, còn lại ghép theo thứ tự
    const ids = answersInput.map((a) => take(unused.findIndex((o) => o.content === a.content.trim())));

    for (let index = 0; index < answersInput.length; index++) {
      const a = answersInput[index];
      const id = ids[index] ?? take(unused.length ? 0 : -1);
      const params = {
        questionId,
        content: a.content.trim(),
        isCorrect: Boolean(a.isCorrect) ? 1 : 0,
        sortOrder: a.sortOrder ?? index,
      };
      if (id) {
        await txQuery(
          `UPDATE answers SET content = @content, is_correct = @isCorrect, sort_order = @sortOrder, updated_at = SYSUTCDATETIME()
           WHERE id = @id`,
          { ...params, id }
        );
      } else {
        await txQuery(
          `INSERT INTO answers (question_id, content, is_correct, sort_order)
           VALUES (@questionId, @content, @isCorrect, @sortOrder)`,
          params
        );
      }
    }
    for (const o of unused) {
      await txQuery('DELETE FROM answers WHERE id = @id', { id: o.id });
    }
  });
}

export async function createQuestion(payload, createdBy) {
  const {
    content,
    questionKind,
    answerType,
    difficulty,
    scope,
    topicId,
    departmentId,
    imageUrl,
    imageCloudinaryId,
    answers,
    usage,
  } = payload;

  if (!content?.trim()) throw new ApiError(400, 'Nội dung câu hỏi là bắt buộc', 'QUESTION_VALIDATION');
  if (!topicId) throw new ApiError(400, 'topicId là bắt buộc', 'QUESTION_VALIDATION');

  validateAnswerSet(answerType, answers);
  const usageValue = parseUsage(usage) ?? QUESTION_USAGE.EXAM;

  const insRes = await query(
    `INSERT INTO questions (content, question_kind, answer_type, difficulty, scope, topic_id, department_id, image_url, image_cloudinary_id, usage, is_active, created_by)
     OUTPUT INSERTED.*
     VALUES (@content, @questionKind, @answerType, @difficulty, @scope, @topicId, @deptId, @imageUrl, @imageCloudinaryId, @usage, 1, @createdBy)`,
    {
      content: content.trim(),
      questionKind,
      answerType,
      difficulty,
      scope,
      topicId,
      deptId: scope === QUESTION_SCOPE.DEPARTMENT_SPECIFIC ? departmentId : null,
      imageUrl: imageUrl || null,
      imageCloudinaryId: imageCloudinaryId || null,
      usage: usageValue,
      createdBy: createdBy || null,
    }
  );

  const question = mapRow(insRes.recordset[0]);
  await replaceAnswers(question.id, answers);
  return getQuestionById(question.id);
}

export async function updateQuestion(id, payload, actorUserId, ipAddress) {
  const current = await getQuestionById(id);
  const previousCloudinaryId = current.imageCloudinaryId;
  const previousUsage = current.usage ?? QUESTION_USAGE.EXAM;
  if (payload.usage !== undefined) parseUsage(payload.usage);

  if (payload.answers) {
    validateAnswerSet(payload.answerType || current.answerType, payload.answers);
  }

  const nextUsage = payload.usage ?? current.usage ?? QUESTION_USAGE.EXAM;
  if (nextUsage === QUESTION_USAGE.PRACTICE && previousUsage !== QUESTION_USAGE.PRACTICE) {
    const activeExam = await findActiveExamUsingTopics([payload.topicId || current.topicId]);
    if (activeExam) {
      throw new ApiError(
        409,
        `Không thể chuyển câu hỏi này sang Ôn tập vì chủ đề của câu hỏi đang được dùng cho kỳ thi "${activeExam.title}" đang diễn ra. Vui lòng đợi kỳ thi kết thúc rồi thử lại.`,
        'QUESTION_USAGE_ACTIVE_EXAM',
      );
    }
  }

  const nextScope = payload.scope !== undefined ? payload.scope : current.scope;
  let nextDeptId = payload.departmentId !== undefined ? payload.departmentId : current.departmentId;
  if (nextScope === QUESTION_SCOPE.COMMON) nextDeptId = null;

  await query(
    `UPDATE questions
     SET content = COALESCE(@content, content),
         question_kind = COALESCE(@questionKind, question_kind),
         answer_type = COALESCE(@answerType, answer_type),
         difficulty = COALESCE(@difficulty, difficulty),
         scope = COALESCE(@scope, scope),
         topic_id = COALESCE(@topicId, topic_id),
         department_id = @deptId,
         image_url = @imageUrl,
         image_cloudinary_id = @imageCloudinaryId,
         usage = COALESCE(@usage, usage),
         is_active = COALESCE(@isActive, is_active),
         updated_at = SYSUTCDATETIME()
     WHERE id = @id`,
    {
      id,
      content: payload.content !== undefined ? payload.content.trim() : null,
      questionKind: payload.questionKind || null,
      answerType: payload.answerType || null,
      difficulty: payload.difficulty || null,
      scope: payload.scope || null,
      topicId: payload.topicId || null,
      deptId: nextDeptId || null,
      imageUrl: payload.imageUrl !== undefined ? payload.imageUrl : current.imageUrl,
      imageCloudinaryId: payload.imageCloudinaryId !== undefined ? payload.imageCloudinaryId : current.imageCloudinaryId,
      usage: payload.usage || null,
      isActive: payload.isActive !== undefined ? (payload.isActive ? 1 : 0) : null,
    }
  );

  if (payload.answers) {
    await replaceAnswers(id, payload.answers);
  }

  if (
    payload.imageCloudinaryId !== undefined &&
    previousCloudinaryId &&
    previousCloudinaryId !== payload.imageCloudinaryId
  ) {
    await deleteQuestionImage(previousCloudinaryId);
  }

  return getQuestionById(id);
}

async function findActiveExamUsingTopics(topicIds) {
  const ids = [...new Set(topicIds.filter(Boolean).map(String))];
  if (ids.length === 0) return null;
  const inClauses = ids.map((_, i) => `@tid_${i}`);
  const params = Object.fromEntries(ids.map((id, i) => [`tid_${i}`, id]));
  const res = await query(
    `SELECT TOP 1 * FROM exams WHERE topic_id IN (${inClauses.join(',')}) AND status = '${EXAM_STATUS.PUBLISHED}'`,
    params
  );
  return mapRow(res.recordset[0]);
}

export async function deactivateQuestion(id, actorUserId, ipAddress) {
  const question = await getQuestionById(id);
  const activeExam = await findActiveExamUsingTopics([question.topicId]);
  if (activeExam) {
    throw new ApiError(
      409,
      `Không thể ngừng sử dụng câu hỏi này vì chủ đề của câu hỏi đang được dùng cho kỳ thi "${activeExam.title}" đang diễn ra. Vui lòng đợi kỳ thi kết thúc rồi thử lại.`,
      'QUESTION_HAS_ACTIVE_EXAM',
    );
  }

  await query('UPDATE questions SET is_active = 0, updated_at = SYSUTCDATETIME() WHERE id = @id', { id });
  return { id: String(id), isActive: false };
}

const SQL_ID_CHUNK = 1000;

// SQL Server giới hạn 2100 tham số mỗi câu lệnh -> chạy theo lô. buildSql nhận chuỗi "@id_0,@id_1,..."
async function queryByIdChunks(ids, buildSql, extraParams = {}) {
  const rows = [];
  for (let start = 0; start < ids.length; start += SQL_ID_CHUNK) {
    const chunk = ids.slice(start, start + SQL_ID_CHUNK);
    const params = { ...extraParams, ...Object.fromEntries(chunk.map((id, i) => [`id_${i}`, id])) };
    const res = await query(buildSql(chunk.map((_, i) => `@id_${i}`).join(',')), params);
    rows.push(...(res.recordset ?? []));
  }
  return rows;
}

export async function moveQuestionsUsage({ ids, filters, targetUsage } = {}) {
  const target = parseUsage(targetUsage, { required: true });
  const source = target === QUESTION_USAGE.PRACTICE ? QUESTION_USAGE.EXAM : QUESTION_USAGE.PRACTICE;

  let matched = [];
  if (Array.isArray(ids) && ids.length > 0) {
    const validIds = ids.filter(Boolean);
    if (!validIds.length) throw new ApiError(400, 'Danh sách ID không hợp lệ', 'QUESTION_BULK_MOVE_INVALID_IDS');
    matched = mapRows(await queryByIdChunks(
      validIds,
      (list) => `SELECT id, topic_id FROM questions WHERE id IN (${list}) AND usage = @source AND is_active = 1`,
      { source },
    ));
  } else if (filters && typeof filters === 'object') {
    const hasSpecific = ['topicId', 'scope', 'departmentId', 'questionKind', 'difficulty', 'answerType', 'search']
      .some((k) => filters[k] !== undefined && filters[k] !== null && filters[k] !== '');
    if (!hasSpecific) {
      throw new ApiError(400, 'Vui lòng chọn ít nhất 1 bộ lọc cụ thể trước khi chuyển', 'QUESTION_BULK_MOVE_NO_FILTER');
    }
    const { where, params } = buildSqlWhere({ ...filters, usage: source, isActive: true });
    const res = await query(`SELECT id, topic_id FROM questions q ${where}`, params);
    matched = mapRows(res.recordset);
  } else {
    throw new ApiError(400, 'Thiếu ids hoặc filters để chuyển hàng loạt', 'QUESTION_BULK_MOVE_MISSING_PARAMS');
  }

  if (matched.length === 0) {
    return { targetUsage: target, movedCount: 0, questionIds: [] };
  }

  if (target === QUESTION_USAGE.PRACTICE) {
    const topicIds = [...new Set(matched.map((q) => String(q.topicId)).filter(Boolean))];
    const activeExam = await findActiveExamUsingTopics(topicIds);
    if (activeExam) {
      throw new ApiError(
        409,
        `Không thể chuyển sang Ôn tập vì câu hỏi thuộc chủ đề đang được dùng cho kỳ thi "${activeExam.title}" đang diễn ra. Vui lòng đợi kỳ thi kết thúc rồi thử lại.`,
        'QUESTION_USAGE_ACTIVE_EXAM',
      );
    }
  }

  const idsToMove = matched.map((q) => q.id);
  await queryByIdChunks(
    idsToMove,
    (list) => `UPDATE questions SET usage = @target, updated_at = SYSUTCDATETIME() WHERE id IN (${list})`,
    { target },
  );

  return {
    targetUsage: target,
    movedCount: matched.length,
    questionIds: matched.map((q) => String(q.id)),
  };
}

export async function deactivateManyQuestions({ ids, filters } = {}, actorUserId, ipAddress) {
  let matched = [];
  if (Array.isArray(ids) && ids.length > 0) {
    const validIds = ids.filter(Boolean);
    if (!validIds.length) throw new ApiError(400, 'Danh sách ID không hợp lệ', 'QUESTION_BULK_DELETE_INVALID_IDS');
    matched = mapRows(await queryByIdChunks(
      validIds,
      (list) => `SELECT id, topic_id FROM questions WHERE id IN (${list}) AND is_active = 1`,
    ));
  } else if (filters && typeof filters === 'object') {
    const hasSpecific = ['topicId', 'scope', 'departmentId', 'questionKind', 'difficulty', 'answerType', 'search']
      .some((k) => filters[k] !== undefined && filters[k] !== null && filters[k] !== '');
    if (!hasSpecific) {
      throw new ApiError(400, 'Vui lòng chọn ít nhất 1 bộ lọc cụ thể trước khi xóa', 'QUESTION_BULK_DELETE_NO_FILTER');
    }
    const { where, params } = buildSqlWhere({ ...filters, isActive: true });
    const res = await query(`SELECT id, topic_id FROM questions q ${where}`, params);
    matched = mapRows(res.recordset);
  } else {
    throw new ApiError(400, 'Thiếu ids hoặc filters để xóa hàng loạt', 'QUESTION_BULK_DELETE_MISSING_PARAMS');
  }

  if (matched.length === 0) {
    return { deactivatedCount: 0, questionIds: [], skippedActiveExam: null };
  }

  const topicIds = [...new Set(matched.map((q) => String(q.topicId)).filter(Boolean))];
  let activeExams = [];
  if (topicIds.length > 0) {
    const inClauses = topicIds.map((_, i) => `@tid_${i}`);
    const params = Object.fromEntries(topicIds.map((id, i) => [`tid_${i}`, id]));
    const res = await query(`SELECT topic_id, title FROM exams WHERE topic_id IN (${inClauses.join(',')}) AND status = '${EXAM_STATUS.PUBLISHED}'`, params);
    activeExams = res.recordset;
  }

  const blockedTopicIds = new Set(activeExams.map((e) => String(e.topic_id)));
  const blocked = matched.filter((q) => blockedTopicIds.has(String(q.topicId)));
  const idsToDeactivate = matched
    .filter((q) => !blockedTopicIds.has(String(q.topicId)))
    .map((q) => q.id);

  await queryByIdChunks(
    idsToDeactivate,
    (list) => `UPDATE questions SET is_active = 0, updated_at = SYSUTCDATETIME() WHERE id IN (${list})`,
  );

  return {
    deactivatedCount: idsToDeactivate.length,
    questionIds: idsToDeactivate.map(String),
    skippedActiveExam: blocked.length > 0
      ? { examTitle: activeExams.map((e) => e.title).join(', '), skippedCount: blocked.length }
      : null,
  };
}

function resolveEnum(map, raw, fieldLabel) {
  const key = normalizeKey(raw);
  const val = map[key];
  if (!val) throw new ApiError(400, `Giá trị không hợp lệ: ${fieldLabel}`, 'IMPORT_ROW_INVALID');
  return val;
}

export function readImportDepartmentRef(r, rowIndex) {
  const code = String(r.mabophan ?? r.maboph ?? r.deptcode ?? '').trim();
  if (!code) throw new ApiError(400, `Dòng ${rowIndex}: câu thuộc phạm vi Riêng phải ghi mã bộ phận`, 'IMPORT_ROW_INVALID');
  return {
    code,
    name: String(r.department ?? r.bophan ?? r.bophanname ?? '').trim(),
    description: String(r.motabophan ?? r.mota ?? r.deptdescription ?? '').trim(),
  };
}

export function buildImportDepartmentNotFound(rowIndex, { code, name, description }) {
  if (!name) {
    return new ApiError(400, `Dòng ${rowIndex}: không tìm thấy bộ phận có mã "${code}"`, 'IMPORT_DEPARTMENT_CODE_UNKNOWN');
  }
  const err = new ApiError(400, `Dòng ${rowIndex}: không tìm thấy bộ phận có mã "${code}" ("${name}")`, 'IMPORT_DEPARTMENT_NOT_FOUND');
  err.departmentName = name;
  err.departmentCode = code;
  err.departmentDescription = description;
  return err;
}

async function buildQuestionFromImportRow(row, rowIndex) {
  const r = mapRowKeys(row);
  const topicName = r.topic ?? r.chude ?? r.chudelon ?? r.topicname;
  const content = r.content ?? r.noidung ?? r.cauhoi;
  if (!topicName || !content) {
    throw new ApiError(400, `Dòng ${rowIndex}: thiếu chủ đề hoặc nội dung câu hỏi`, 'IMPORT_ROW_INVALID');
  }

  const topic = await findOrCreateTopicByName(String(topicName));
  const scope = resolveEnum(SCOPE_MAP, r.scope ?? r.phamvi ?? 'common', 'scope');
  let departmentId;
  if (scope === QUESTION_SCOPE.DEPARTMENT_SPECIFIC) {
    const ref = readImportDepartmentRef(r, rowIndex);
    const dept = await findDepartmentByCode(ref.code);
    if (!dept) throw buildImportDepartmentNotFound(rowIndex, ref);
    departmentId = dept.id;
  }

  const questionKind = resolveEnum(KIND_MAP, r.questionkind ?? r.loai ?? r.kind ?? 'theory', 'questionKind');
  const answerType = resolveEnum(ANSWER_TYPE_MAP, r.answertype ?? r.dapan ?? r.answer_type ?? 'single', 'answerType');
  const difficulty = resolveEnum(DIFFICULTY_MAP, r.difficulty ?? r.dokho ?? 'medium', 'difficulty');

  const options = [];
  for (let i = 1; i <= 8; i += 1) {
    const val = r[`option${i}`] ?? r[`luachon${i}`];
    if (val != null && String(val).trim() !== '') {
      options.push({ index: i, content: String(val).trim() });
    }
  }
  if (options.length < 2) throw new ApiError(400, `Dòng ${rowIndex}: cần ít nhất 2 phương án`, 'IMPORT_ROW_INVALID');

  const correctIndices = parseCorrectIndices(r.correct ?? r.dapanung ?? r.correctoptions ?? r.dapandung);
  if (correctIndices.length === 0) throw new ApiError(400, `Dòng ${rowIndex}: thiếu đáp án đúng`, 'IMPORT_ROW_INVALID');

  const answers = options.map((o) => ({
    content: o.content,
    isCorrect: correctIndices.includes(o.index),
    sortOrder: o.index - 1,
  }));
  validateAnswerSet(answerType, answers);

  return {
    content: String(content).trim(),
    questionKind,
    answerType,
    difficulty,
    scope,
    topicId: topic.id,
    departmentId,
    answers,
  };
}

function readImportRows(filePath) {
  if (!fs.existsSync(filePath)) throw new ApiError(400, 'Không đọc được file upload', 'IMPORT_FILE_MISSING');
  let workbook;
  try {
    workbook = XLSX.read(fs.readFileSync(filePath), { type: 'buffer', cellDates: false });
  } catch (err) {
    throw new ApiError(400, 'File không đúng định dạng Excel hoặc đã bị hỏng.', 'IMPORT_INVALID_FORMAT');
  }
  const sheetName = workbook.SheetNames[0];
  if (!sheetName) throw new ApiError(400, 'File Excel không có sheet', 'IMPORT_EMPTY');
  const rows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { defval: '' });
  if (!rows.length) throw new ApiError(400, 'Sheet trống', 'IMPORT_EMPTY');
  return rows;
}

async function loadSeenKeys(usage) {
  const res = await query(
    'SELECT content, topic_id, scope, department_id FROM questions WHERE is_active = 1 AND usage = @usage',
    { usage }
  );
  return new Set(
    res.recordset.map((q) =>
      [
        q.topic_id ? String(q.topic_id) : '',
        q.scope,
        q.department_id ? String(q.department_id) : '',
        normalizeContentForDedupe(q.content),
      ].join('|')
    )
  );
}

function buildDedupeKey(payload) {
  return [
    payload.topicId ? String(payload.topicId) : '',
    payload.scope,
    payload.departmentId ? String(payload.departmentId) : '',
    normalizeContentForDedupe(payload.content),
  ].join('|');
}

function resolveImportTokenPath(token) {
  const safe = path.basename(String(token ?? ''));
  if (!safe || safe !== token) throw new ApiError(400, 'Token import không hợp lệ', 'IMPORT_TOKEN_INVALID');
  return path.join(path.resolve(env.uploadDir), safe);
}

export async function previewImportQuestionsFromExcelFile(filePath, usage) {
  let usageValue;
  try {
    usageValue = parseUsage(usage, { required: true });
  } catch (err) {
    try { fs.unlinkSync(filePath); } catch {}
    throw err;
  }

  const rows = readImportRows(filePath);
  const seenKeys = await loadSeenKeys(usageValue);

  const ready = [];
  const duplicates = [];
  const errors = [];
  const missingDepts = new Map();

  for (let i = 0; i < rows.length; i += 1) {
    const rowIndex = i + 2;
    try {
      const payload = await buildQuestionFromImportRow(rows[i], rowIndex);
      const dedupeKey = buildDedupeKey(payload);
      if (seenKeys.has(dedupeKey)) {
        duplicates.push({ row: rowIndex, content: payload.content.slice(0, 120) });
      } else {
        seenKeys.add(dedupeKey);
        ready.push({ row: rowIndex, content: payload.content.slice(0, 120) });
      }
    } catch (err) {
      if (err.code === 'IMPORT_DEPARTMENT_NOT_FOUND') {
        const key = normalizeDeptName(err.departmentName);
        const entry = missingDepts.get(key) ?? {
          name: err.departmentName,
          code: '',
          description: '',
          rowCount: 0,
        };
        entry.rowCount += 1;
        if (!entry.code && err.departmentCode) entry.code = err.departmentCode;
        if (!entry.description && err.departmentDescription) entry.description = err.departmentDescription;
        missingDepts.set(key, entry);
      }
      errors.push({
        row: rowIndex,
        message: err.message ?? 'Lỗi không xác định',
        code: err.code ?? 'IMPORT_ROW_ERROR',
      });
    }
  }

  return {
    token: path.basename(filePath),
    usage: usageValue,
    totalRows: rows.length,
    readyCount: ready.length,
    duplicateCount: duplicates.length,
    errorCount: errors.length,
    missingDepartments: [...missingDepts.values()],
    duplicates,
    ready,
    errors,
  };
}

export async function confirmImportQuestions(token, options, createdBy, actorUserId, ipAddress) {
  const { createDepartments = [], keepDuplicateRows = [], usage } = options ?? {};
  const usageValue = parseUsage(usage, { required: true });
  const filePath = resolveImportTokenPath(token);
  if (!fs.existsSync(filePath)) {
    throw new ApiError(400, 'Phiên import đã hết hạn, vui lòng tải lại file', 'IMPORT_TOKEN_EXPIRED');
  }

  for (const dept of createDepartments) {
    const name = dept?.name?.trim();
    if (!name) continue;
    const code = dept?.code?.trim();
    if (!code) {
      throw new ApiError(400, `Vui lòng nhập mã bộ phận cho "${name}"`, 'IMPORT_DEPARTMENT_CODE_REQUIRED');
    }
    await upsertDepartmentForImport({ name, code, description: dept?.description });
  }

  const rows = readImportRows(filePath);
  const seenKeys = await loadSeenKeys(usageValue);
  const keepSet = new Set(keepDuplicateRows);

  const created = [];
  const errors = [];
  const skippedDuplicates = [];

  for (let i = 0; i < rows.length; i += 1) {
    const rowIndex = i + 2;
    try {
      const payload = await buildQuestionFromImportRow(rows[i], rowIndex);
      const dedupeKey = buildDedupeKey(payload);

      if (seenKeys.has(dedupeKey) && !keepSet.has(rowIndex)) {
        skippedDuplicates.push({ row: rowIndex, content: payload.content.slice(0, 80) });
        continue;
      }

      const insQ = await query(
        `INSERT INTO questions (content, question_kind, answer_type, difficulty, scope, usage, topic_id, department_id, created_by, is_active)
         OUTPUT INSERTED.id
         VALUES (@content, @kind, @ansType, @difficulty, @scope, @usage, @topicId, @deptId, @createdBy, 1)`,
        {
          content: payload.content,
          kind: payload.questionKind,
          ansType: payload.answerType,
          difficulty: payload.difficulty,
          scope: payload.scope,
          usage: usageValue,
          topicId: payload.topicId,
          deptId: payload.departmentId || null,
          createdBy: createdBy || null,
        }
      );
      const questionId = insQ.recordset[0].id;
      await replaceAnswers(questionId, payload.answers);
      created.push(String(questionId));
      seenKeys.add(dedupeKey);
    } catch (err) {
      errors.push({
        row: rowIndex,
        message: err.message ?? 'Lỗi không xác định',
        code: err.code ?? 'IMPORT_ROW_ERROR',
      });
    }
  }

  try { fs.unlinkSync(filePath); } catch {}

  return {
    usage: usageValue,
    imported: created.length,
    failed: errors.length,
    skipped: skippedDuplicates.length,
    errors,
    skippedDuplicates,
    questionIds: created,
  };
}

// ============================================================================
// IMPORT TỪ FILE WORD (.docx)
// ============================================================================

function stripHtmlToText(html) {
  return String(html ?? '')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\u00A0/g, ' ')
    .trim();
}

function decodeBasicEntities(str) {
  return String(str ?? '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\u00A0/g, ' ')
    .replace(/&amp;/g, '&');
}

function htmlToUnderlineChars(html) {
  const chars = [];
  let underlineDepth = 0;
  for (const token of String(html ?? '').split(/(<[^>]+>)/)) {
    if (!token) continue;
    if (token.startsWith('<')) {
      if (/^<u(\s[^>]*)?>$/i.test(token)) underlineDepth += 1;
      else if (/^<\/u>$/i.test(token) && underlineDepth > 0) underlineDepth -= 1;
      continue;
    }
    for (const ch of decodeBasicEntities(token)) chars.push({ ch, u: underlineDepth > 0 });
  }
  return chars;
}

function measureUnderlineRatio(chars) {
  let total = 0;
  let underlined = 0;
  for (const c of chars) {
    if (!/[\p{L}\p{N}]/u.test(c.ch)) continue;
    total += 1;
    if (c.u) underlined += 1;
  }
  return { total, underlined, ratio: total === 0 ? 0 : underlined / total };
}

const WORD_UNDERLINE_CORRECT_RATIO = 0.6;
const WORD_STYLE_MAP = ["u => u", "strike => s", "b => strong", "i => em"];

async function readWordParagraphs(filePath) {
  if (!fs.existsSync(filePath)) throw new ApiError(400, 'Không đọc được file upload', 'IMPORT_FILE_MISSING');
  let result;
  try {
    result = await mammoth.convertToHtml({ path: filePath }, { styleMap: WORD_STYLE_MAP });
  } catch (err) {
    throw new ApiError(400, 'File không đúng định dạng Word (.docx) hoặc đã bị hỏng.', 'IMPORT_INVALID_FORMAT');
  }
  const html = result.value ?? '';
  const matches = [...html.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/g)];
  if (matches.length === 0) throw new ApiError(400, 'File Word trống', 'IMPORT_EMPTY');
  return matches.map((m) => ({
    html: m[1],
    text: stripHtmlToText(m[1]),
    hasUnderline: /<u>/.test(m[1]),
    chars: htmlToUnderlineChars(m[1]),
  }));
}

const WORD_HEADER_RE =
  /^C[aâ]u\s*\d+\s*:\s*\(\s*ch[uủ]\s*đ[eề]\s*:\s*(.*?)\s*-\s*b[ôộ]\s*ph[aậ]n\s*:\s*(.*?)\s*-\s*đ[ôộ]\s*kh[óo]\s*:\s*(.*?)\s*\)\s*(.*)$/iu;
const WORD_OPTION_RE = /^(\*)?\s*([A-Za-z])\s*[.)]\s*(.+)$/u;

async function readImportRowsFromWord(filePath) {
  const paragraphs = await readWordParagraphs(filePath);

  const blocks = [];
  for (const p of paragraphs) {
    const headerMatch = p.text.match(WORD_HEADER_RE);
    if (headerMatch) {
      const numMatch = p.text.match(/^C[aâ]u\s*(\d+)/iu);
      blocks.push({
        questionNumber: numMatch ? Number(numMatch[1]) : blocks.length + 1,
        topicName: headerMatch[1].trim(),
        deptName: headerMatch[2].trim(),
        difficultyRaw: headerMatch[3].trim(),
        content: headerMatch[4].trim(),
        optionParagraphs: [],
      });
      continue;
    }
    if (blocks.length === 0) continue;
    if (p.text.trim() === '') continue;
    blocks[blocks.length - 1].optionParagraphs.push(p);
  }

  if (blocks.length === 0) {
    throw new ApiError(400, 'Không tìm thấy câu hỏi đúng mẫu Word', 'IMPORT_EMPTY');
  }

  let starTotal = 0;
  let underlineTotal = 0;
  const parsedBlocks = blocks.map((b) => {
    const options = [];
    for (const p of b.optionParagraphs) {
      const m = p.text.match(WORD_OPTION_RE);
      if (!m) continue;
      const starMarked = Boolean(m[1]);
      const fullText = p.chars.map((c) => c.ch).join('');
      const prefix = fullText.match(/^\s*\*?\s*[A-Za-z]\s*[.)]\s*/u);
      const contentChars = p.chars.slice(prefix ? prefix[0].length : 0);
      const { total, underlined, ratio } = measureUnderlineRatio(contentChars);
      const underlineMarked = total > 0 && ratio >= WORD_UNDERLINE_CORRECT_RATIO;
      const underlinePartial = underlined > 0 && underlined < total;
      if (starMarked) starTotal += 1;
      if (underlineMarked) underlineTotal += 1;
      options.push({
        index: options.length + 1,
        letter: m[2].toUpperCase(),
        content: m[3].trim(),
        starMarked,
        underlineMarked,
        underlinePartial,
      });
    }
    return { ...b, options };
  });

  const dominant = underlineTotal >= starTotal ? 'underline' : 'star';

  const rows = [];
  const meta = [];
  for (const b of parsedBlocks) {
    const starSet = b.options.filter((o) => o.starMarked).map((o) => o.index);
    const underlineSet = b.options.filter((o) => o.underlineMarked).map((o) => o.index);
    const dominantSet = dominant === 'underline' ? underlineSet : starSet;
    const minoritySet = dominant === 'underline' ? starSet : underlineSet;

    let suggestedCorrect;
    let ambiguous;
    if (dominantSet.length > 0 && minoritySet.length === 0) {
      suggestedCorrect = dominantSet;
      ambiguous = false;
    } else if (dominantSet.length === 0 && minoritySet.length > 0) {
      suggestedCorrect = minoritySet;
      ambiguous = true;
    } else if (dominantSet.length > 0 && minoritySet.length > 0) {
      suggestedCorrect = dominantSet;
      ambiguous = starSet.slice().sort().join(',') !== underlineSet.slice().sort().join(',');
    } else {
      suggestedCorrect = [];
      ambiguous = false;
    }

    const rowObj = {
      topic: b.topicName,
      content: b.content,
      difficulty: b.difficultyRaw,
      scope: b.deptName ? 'departmentspecific' : 'common',
      mabophan: b.deptName,
      correct: suggestedCorrect.join(','),
      questionkind: 'theory',
      answertype: suggestedCorrect.length > 1 ? 'multiple' : 'single',
    };
    for (const opt of b.options) {
      rowObj[`option${opt.index}`] = opt.content;
    }

    rows.push(rowObj);
    meta.push({
      questionNumber: b.questionNumber,
      ambiguous,
      suggestedCorrect,
      options: b.options.map((o) => ({
        index: o.index,
        letter: o.letter,
        content: o.content,
        starMarked: o.starMarked,
        underlineMarked: o.underlineMarked,
        underlinePartial: o.underlinePartial,
      })),
      hasPartialUnderline: b.options.some((o) => o.underlinePartial),
    });
  }

  return { rows, meta, dominantMarking: dominant };
}

function relabelRowError(err) {
  if (!err?.message) return err;
  const msg = err.message.replace(/Dòng\s*(\d+):/gi, 'Câu $1:');
  err.message = msg;
  return err;
}

export async function previewImportQuestionsFromWordFile(filePath, usage) {
  let usageValue;
  try {
    usageValue = parseUsage(usage, { required: true });
  } catch (err) {
    try { fs.unlinkSync(filePath); } catch {}
    throw err;
  }

  const { rows, meta, dominantMarking } = await readImportRowsFromWord(filePath);
  const seenKeys = await loadSeenKeys(usageValue);

  const ready = [];
  const duplicates = [];
  const errors = [];
  const needsReview = [];

  for (let i = 0; i < rows.length; i += 1) {
    const m = meta[i];
    try {
      const payload = await buildQuestionFromImportRow(rows[i], m.questionNumber);
      const dedupeKey = buildDedupeKey(payload);

      const duplicate = seenKeys.has(dedupeKey);
      const needsCheck = m.ambiguous || m.hasPartialUnderline;
      seenKeys.add(dedupeKey);
      if (needsCheck) {
        needsReview.push({
          row: m.questionNumber,
          content: payload.content.slice(0, 120),
          options: m.options,
          suggestedCorrect: m.suggestedCorrect,
          reasons: [m.ambiguous && 'minority', m.hasPartialUnderline && 'partialUnderline'].filter(Boolean),
          duplicate,
        });
      }
      // Câu trùng (kể cả câu cần xác nhận) mặc định bị bỏ qua khi nhập -> phải hiện ở danh sách trùng
      if (duplicate) {
        duplicates.push({ row: m.questionNumber, content: payload.content.slice(0, 120) });
      } else if (!needsCheck) {
        ready.push({ row: m.questionNumber, content: payload.content.slice(0, 120) });
      }
    } catch (err) {
      const relabeled = relabelRowError(err);
      errors.push({
        row: m.questionNumber,
        message: relabeled.message ?? 'Lỗi không xác định',
        code: relabeled.code ?? 'IMPORT_ROW_ERROR',
      });
    }
  }

  return {
    token: path.basename(filePath),
    usage: usageValue,
    format: 'word',
    dominantMarking,
    totalRows: rows.length,
    readyCount: ready.length,
    duplicateCount: duplicates.length,
    needsReviewCount: needsReview.length,
    errorCount: errors.length,
    missingDepartments: [],
    duplicates,
    ready,
    errors,
    needsReview,
  };
}

export async function confirmImportQuestionsFromWord(token, options, createdBy, actorUserId, ipAddress) {
  const { keepDuplicateRows = [], correctOverrides, usage } = options ?? {};
  const overrides = correctOverrides ?? {};
  const usageValue = parseUsage(usage, { required: true });
  const filePath = resolveImportTokenPath(token);
  if (!fs.existsSync(filePath)) {
    throw new ApiError(400, 'Phiên import Word đã hết hạn, vui lòng tải lại file', 'IMPORT_TOKEN_EXPIRED');
  }

  const { rows, meta } = await readImportRowsFromWord(filePath);
  const seenKeys = await loadSeenKeys(usageValue);
  const keepSet = new Set(keepDuplicateRows);

  const created = [];
  const errors = [];
  const skippedDuplicates = [];

  for (let i = 0; i < rows.length; i += 1) {
    const m = meta[i];
    const row = { ...rows[i] };
    const override = overrides[String(m.questionNumber)] ?? overrides[m.questionNumber];
    if (Array.isArray(override) && override.length > 0) {
      row.correct = override.join(',');
      row.answertype = override.length > 1 ? 'multiple' : 'single';
    }

    try {
      const payload = await buildQuestionFromImportRow(row, m.questionNumber);
      const dedupeKey = buildDedupeKey(payload);

      if (seenKeys.has(dedupeKey) && !keepSet.has(m.questionNumber)) {
        skippedDuplicates.push({ row: m.questionNumber, content: payload.content.slice(0, 80) });
        continue;
      }

      const insQ = await query(
        `INSERT INTO questions (content, question_kind, answer_type, difficulty, scope, usage, topic_id, department_id, created_by, is_active)
         OUTPUT INSERTED.id
         VALUES (@content, @kind, @ansType, @difficulty, @scope, @usage, @topicId, @deptId, @createdBy, 1)`,
        {
          content: payload.content,
          kind: payload.questionKind,
          ansType: payload.answerType,
          difficulty: payload.difficulty,
          scope: payload.scope,
          usage: usageValue,
          topicId: payload.topicId,
          deptId: payload.departmentId || null,
          createdBy: createdBy || null,
        }
      );
      const questionId = insQ.recordset[0].id;
      await replaceAnswers(questionId, payload.answers);
      created.push(String(questionId));
      seenKeys.add(dedupeKey);
    } catch (err) {
      const relabeled = relabelRowError(err);
      errors.push({
        row: m.questionNumber,
        message: relabeled.message ?? 'Lỗi không xác định',
        code: relabeled.code ?? 'IMPORT_ROW_ERROR',
      });
    }
  }

  try { fs.unlinkSync(filePath); } catch {}

  return {
    usage: usageValue,
    imported: created.length,
    failed: errors.length,
    skipped: skippedDuplicates.length,
    errors,
    skippedDuplicates,
    questionIds: created,
  };
}

export async function getQuestionStatsByTopic(topicId) {
  const commonRes = await query(
    `SELECT COUNT(1) AS count FROM questions WHERE topic_id = @topicId AND scope = 'Common' AND is_active = 1 AND usage = 'exam'`,
    { topicId }
  );
  const commonCount = commonRes.recordset[0]?.count ?? 0;

  const deptCountsRes = await query(
    `SELECT department_id, COUNT(1) AS count FROM questions 
     WHERE topic_id = @topicId AND scope = 'DepartmentSpecific' AND is_active = 1 AND usage = 'exam'
     GROUP BY department_id`,
    { topicId }
  );
  const countByDeptId = new Map(deptCountsRes.recordset.map((d) => [String(d.department_id), d.count]));

  const deptsRes = await query('SELECT id, name, code FROM departments WHERE is_active = 1 ORDER BY name ASC');
  const departments = mapRows(deptsRes.recordset);

  const empPrimaryRes = await query('SELECT department_id FROM employees WHERE is_active = 1');
  const empExtraRes = await query(
    'SELECT eed.department_id FROM employee_extra_departments eed JOIN employees e ON eed.employee_id = e.id WHERE e.is_active = 1'
  );

  const employeeCountByDeptId = new Map();
  for (const emp of empPrimaryRes.recordset) {
    if (emp.department_id) {
      const idStr = String(emp.department_id);
      employeeCountByDeptId.set(idStr, (employeeCountByDeptId.get(idStr) || 0) + 1);
    }
  }
  for (const extra of empExtraRes.recordset) {
    if (extra.department_id) {
      const idStr = String(extra.department_id);
      employeeCountByDeptId.set(idStr, (employeeCountByDeptId.get(idStr) || 0) + 1);
    }
  }

  return {
    topicId: String(topicId),
    commonCount,
    departments: departments.map((dept) => {
      const dIdStr = String(dept.id);
      return {
        departmentId: dIdStr,
        name: dept.name,
        code: dept.code,
        count: countByDeptId.get(dIdStr) ?? 0,
        employeeCount: employeeCountByDeptId.get(dIdStr) ?? 0,
      };
    }),
  };
}
