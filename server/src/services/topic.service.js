/**
 * Service Quản lý Chủ đề / Chuyên môn Câu hỏi (Topic Service) - Triển khai SQL Server.
 * Hỗ trợ tạo mới, cập nhật, tự động khôi phục chủ đề cũ đã xóa mềm và bảo vệ toàn vẹn dữ liệu kỳ thi.
 */

import { query, mapRow, mapRows } from '../db/sql-helpers.js';
import { ApiError, assertFound } from '../utils/api-error.js';
import { QUESTION_USAGE, EXAM_STATUS } from '../models/constants.js';

// Lấy danh sách toàn bộ chủ đề câu hỏi
export async function listTopics({ activeOnly = true, withCounts = false } = {}) {
  const sqlText = activeOnly
    ? 'SELECT id, name, description, is_active, created_at, updated_at FROM topics WHERE is_active = 1 ORDER BY name ASC'
    : 'SELECT id, name, description, is_active, created_at, updated_at FROM topics ORDER BY name ASC';
  const res = await query(sqlText);
  const topics = mapRows(res.recordset);
  if (!withCounts || topics.length === 0) return topics;

  const countRes = await query(
    `SELECT topic_id, usage, COUNT(1) AS count 
     FROM questions 
     WHERE is_active = 1 
     GROUP BY topic_id, usage`
  );

  const countsByTopic = new Map();
  for (const row of countRes.recordset) {
    const key = String(row.topic_id);
    const entry = countsByTopic.get(key) ?? { exam: 0, practice: 0 };
    if (row.usage === QUESTION_USAGE.PRACTICE) entry.practice += row.count;
    else entry.exam += row.count;
    countsByTopic.set(key, entry);
  }

  return topics.map((t) => ({
    ...t,
    questionCounts: countsByTopic.get(String(t.id)) ?? { exam: 0, practice: 0 },
  }));
}

// Tạo chủ đề mới (tự động khôi phục nếu tên trùng với chủ đề đã xóa mềm trước đó)
export async function createTopic({ name, description }) {
  const trimmed = name?.trim();
  if (!trimmed) {
    throw new ApiError(400, 'Tên chủ đề là bắt buộc', 'TOPIC_VALIDATION');
  }

  const existingRes = await query('SELECT * FROM topics WHERE name = @name', { name: trimmed });
  let existing = mapRow(existingRes.recordset[0]);

  if (existing) {
    if (!existing.isActive) {
      const updated = await query(
        `UPDATE topics 
         SET is_active = 1, description = ISNULL(@description, description), updated_at = SYSUTCDATETIME()
         OUTPUT INSERTED.* WHERE id = @id`,
        { id: existing.id, description: description !== undefined ? (description?.trim() || '') : null }
      );
      return { ...mapRow(updated.recordset[0]), restored: true };
    }
    throw new ApiError(409, 'Chủ đề đã tồn tại', 'TOPIC_DUPLICATE');
  }

  try {
    const ins = await query(
      `INSERT INTO topics (name, description, is_active)
       OUTPUT INSERTED.* VALUES (@name, @description, 1)`,
      { name: trimmed, description: description?.trim() || null }
    );
    return { ...mapRow(ins.recordset[0]), restored: false };
  } catch (err) {
    if (err.number === 2627 || err.number === 2601) {
      throw new ApiError(409, 'Chủ đề đã tồn tại', 'TOPIC_DUPLICATE');
    }
    throw err;
  }
}

const formatVN = (value) => new Date(value).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });

export function evaluateTopicDeactivation(topicName, exams, { now = new Date(), force = false } = {}) {
  const ofStatus = (status) => exams.filter((e) => e.status === status);

  const published = ofStatus(EXAM_STATUS.PUBLISHED)[0];
  if (published) {
    return {
      code: 'TOPIC_HAS_ACTIVE_EXAM',
      message: `Không thể ngừng sử dụng chủ đề "${topicName}" vì chủ đề này đang được dùng cho kỳ thi "${published.title}" đang diễn ra. Vui lòng đợi kỳ thi kết thúc rồi thử lại.`,
    };
  }

  const pending = ofStatus(EXAM_STATUS.PENDING_REVIEW)[0];
  if (pending) {
    return {
      code: 'TOPIC_HAS_PENDING_EXAM',
      message: `Không thể ngừng sử dụng chủ đề "${topicName}" vì chủ đề này đang có đề xuất kỳ thi "${pending.title}" chờ Người duyệt đề xem xét. Vui lòng đợi đề xuất được duyệt hoặc từ chối rồi thử lại.`,
    };
  }

  const approved = ofStatus(EXAM_STATUS.APPROVED);
  const live = approved.find((e) => !e.endDate || new Date(e.endDate) > now);
  if (live) {
    return {
      code: 'TOPIC_HAS_APPROVED_EXAM',
      message: `Không thể ngừng sử dụng chủ đề "${topicName}" vì chủ đề này đã được duyệt cho kỳ thi "${live.title}" nhưng chưa đăng chính thức. Vui lòng đợi kỳ thi được đăng và kết thúc rồi thử lại (hoặc nhờ Người duyệt đề chọn "Bỏ qua" đề xuất này).`,
    };
  }

  const expired = approved.filter((e) => e.endDate && new Date(e.endDate) <= now);
  if (expired.length > 0 && force !== true) {
    const list = expired.map((e) => `"${e.title}" (kết thúc lúc ${formatVN(e.endDate)})`).join(', ');
    return {
      code: 'TOPIC_HAS_EXPIRED_EXAM',
      message: `Chủ đề "${topicName}" có kỳ thi đã duyệt nhưng quá hạn mà chưa được đăng: ${list}. Kỳ thi này không thể đăng chính thức nữa nên việc ngừng sử dụng chủ đề không ảnh hưởng đến thí sinh. Bạn có chắc muốn tiếp tục ngừng sử dụng chủ đề không?`,
    };
  }

  return null;
}

async function assertTopicDeactivatable(topic, { force = false } = {}) {
  const examsRes = await query(
    `SELECT title, status, end_date AS endDate FROM exams
     WHERE topic_id = @topicId AND status IN (@s1, @s2, @s3)`,
    { topicId: topic.id, s1: EXAM_STATUS.PUBLISHED, s2: EXAM_STATUS.PENDING_REVIEW, s3: EXAM_STATUS.APPROVED }
  );
  const verdict = evaluateTopicDeactivation(topic.name, mapRows(examsRes.recordset), { force });
  if (verdict) throw new ApiError(409, verdict.message, verdict.code);
}

// Cập nhật tên và mô tả của chủ đề
export async function updateTopic(id, { name, description, isActive } = {}) {
  const topicRes = await query('SELECT * FROM topics WHERE id = @id', { id });
  const topic = mapRow(topicRes.recordset[0]);
  assertFound(topic, 'Không tìm thấy chủ đề', 'TOPIC_NOT_FOUND');

  let trimmedName = topic.name;
  if (name !== undefined) {
    trimmedName = name?.trim();
    if (!trimmedName) throw new ApiError(400, 'Tên chủ đề là bắt buộc', 'TOPIC_VALIDATION');
  }

  const newDescription = description !== undefined ? (description?.trim() || '') : topic.description;
  let newIsActive = topic.isActive;
  if (isActive !== undefined) {
    if (!isActive && topic.isActive) await assertTopicDeactivatable(topic);
    newIsActive = Boolean(isActive);
  }

  try {
    const updateRes = await query(
      `UPDATE topics 
       SET name = @name, description = @description, is_active = @isActive, updated_at = SYSUTCDATETIME()
       OUTPUT INSERTED.* WHERE id = @id`,
      { id, name: trimmedName, description: newDescription, isActive: newIsActive }
    );
    return mapRow(updateRes.recordset[0]);
  } catch (err) {
    if (err.number === 2627 || err.number === 2601) {
      throw new ApiError(409, 'Chủ đề đã tồn tại', 'TOPIC_DUPLICATE');
    }
    throw err;
  }
}

// Ngừng kích hoạt chủ đề (Xóa mềm)
export async function deactivateTopic(id, { force = false } = {}) {
  const topicRes = await query('SELECT * FROM topics WHERE id = @id', { id });
  const topic = mapRow(topicRes.recordset[0]);
  assertFound(topic, 'Không tìm thấy chủ đề', 'TOPIC_NOT_FOUND');

  await assertTopicDeactivatable(topic, { force });

  await query('UPDATE topics SET is_active = 0, updated_at = SYSUTCDATETIME() WHERE id = @id', { id });
  await query('UPDATE questions SET is_active = 0, updated_at = SYSUTCDATETIME() WHERE topic_id = @id AND is_active = 1', { id });

  return { id: String(topic.id), isActive: false };
}

// Tìm hoặc tự động tạo chủ đề theo tên
export async function findOrCreateTopicByName(name) {
  const trimmed = name?.trim();
  if (!trimmed) throw new ApiError(400, 'Tên chủ đề là bắt buộc', 'TOPIC_VALIDATION');

  let topicRes = await query('SELECT * FROM topics WHERE name = @name', { name: trimmed });
  let topic = mapRow(topicRes.recordset[0]);

  if (!topic) {
    const ins = await query(
      `INSERT INTO topics (name, is_active) OUTPUT INSERTED.* VALUES (@name, 1)`,
      { name: trimmed }
    );
    return mapRow(ins.recordset[0]);
  } else if (!topic.isActive) {
    const upd = await query(
      `UPDATE topics SET is_active = 1, updated_at = SYSUTCDATETIME() OUTPUT INSERTED.* WHERE id = @id`,
      { id: topic.id }
    );
    return mapRow(upd.recordset[0]);
  }
  return topic;
}

// Lấy thông tin chi tiết một chủ đề theo ID
export async function getTopicById(id) {
  const topicRes = await query('SELECT * FROM topics WHERE id = @id', { id });
  const topic = mapRow(topicRes.recordset[0]);
  assertFound(topic, 'Không tìm thấy chủ đề', 'TOPIC_NOT_FOUND');
  return topic;
}
