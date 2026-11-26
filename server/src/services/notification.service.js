/**
 * Service Thông báo Hệ thống (Notification Service) - Triển khai SQL Server.
 * Tự động gửi thông báo theo các sự kiện: Nộp đề xuất thi, Phê duyệt/Từ chối, Công bố kỳ thi và Cảnh báo phát đề lỗi.
 */

import { query, mapRow, mapRows } from '../db/sql-helpers.js';

function formatDateTime(date) {
  if (!date) return '';
  return new Date(date).toLocaleString('vi-VN');
}

export const notificationService = {
  // Tạo 1 thông báo cho một người dùng cụ thể
  async create({ recipientUserId, type, title, message, examId }) {
    const res = await query(
      `INSERT INTO notifications (recipient_user_id, type, title, message, exam_id, is_read)
       OUTPUT INSERTED.*
       VALUES (@recipientUserId, @type, @title, @message, @examId, 0)`,
      {
        recipientUserId,
        type,
        title,
        message,
        examId: examId || null,
      }
    );
    return mapRow(res.recordset[0]);
  },

  // Tạo hàng loạt thông báo cho danh sách nhiều người nhận
  async createMany(recipientUserIds, { type, title, message, examId }) {
    if (!recipientUserIds?.length) return [];
    const uniqueIds = [...new Set(recipientUserIds.map(String))];
    const created = [];
    for (const uid of uniqueIds) {
      const doc = await this.create({
        recipientUserId: uid,
        type,
        title,
        message,
        examId,
      });
      created.push(doc);
    }
    return created;
  },

  // Xóa mọi thông báo gắn với 1 kỳ thi đã bị xóa hẳn
  async deleteByExam(examId) {
    await query('DELETE FROM notifications WHERE exam_id = @examId', { examId });
  },

  // Sự kiện: Examiner gửi duyệt đề xuất -> Báo cho tất cả Leader đang hoạt động
  async notifyExamSubmitted(exam) {
    const leadersRes = await query(
      `SELECT u.id FROM users u
       JOIN roles r ON u.role_id = r.id
       WHERE r.code = 'leader' AND u.is_active = 1`
    );
    const recipientIds = leadersRes.recordset.map((u) => String(u.id));

    return this.createMany(recipientIds, {
      type: 'exam_submitted',
      title: 'Có đề xuất kỳ thi mới chờ duyệt',
      message: `Kỳ thi "${exam.title}" vừa được gửi duyệt, đang chờ bạn phê duyệt hoặc từ chối.`,
      examId: exam.id || exam._id,
    });
  },

  // Sự kiện: Leader phê duyệt đề xuất -> Báo cho Examiner người tạo đề xuất
  async notifyExamApproved(exam) {
    const createdBy = exam.createdBy || exam.created_by;
    if (!createdBy) return null;
    return this.create({
      recipientUserId: createdBy,
      type: 'exam_approved',
      title: 'Đề xuất kỳ thi đã được phê duyệt',
      message: `Kỳ thi "${exam.title}" đã được phê duyệt. Thời gian diễn ra: ${formatDateTime(exam.startDate || exam.start_date)} - ${formatDateTime(exam.endDate || exam.end_date)}.`,
      examId: exam.id || exam._id,
    });
  },

  // Sự kiện: Leader từ chối đề xuất -> Báo cho Examiner kèm lý do từ chối
  async notifyExamRejected(exam) {
    const createdBy = exam.createdBy || exam.created_by;
    if (!createdBy) return null;
    return this.create({
      recipientUserId: createdBy,
      type: 'exam_rejected',
      title: 'Đề xuất kỳ thi đã bị từ chối',
      message: `Kỳ thi "${exam.title}" đã bị từ chối. Lý do: ${exam.rejectionReason || exam.rejection_reason || 'Không có lý do'}.`,
      examId: exam.id || exam._id,
    });
  },

  // Sự kiện: Leader công bố chính thức kỳ thi -> Báo cho tất cả thí sinh và cán bộ liên quan
  async notifyExamPublished(exam, publisherId) {
    const staffRes = await query(
      `SELECT u.id FROM users u
       JOIN roles r ON u.role_id = r.id
       WHERE u.is_active = 1 AND u.id <> @pubId AND r.code NOT IN ('admin', 'candidate')`,
      { pubId: publisherId }
    );
    const recipientIdSet = new Set(staffRes.recordset.map((r) => String(r.id)));

    const examId = exam.id || exam._id;
    const candidatesRes = await query(
      `SELECT e.user_id FROM exam_candidates ec
       JOIN employees e ON ec.employee_id = e.id
       WHERE ec.exam_id = @examId AND e.user_id IS NOT NULL AND e.user_id <> @pubId`,
      { examId, pubId: publisherId }
    );
    for (const row of candidatesRes.recordset) {
      recipientIdSet.add(String(row.user_id));
    }

    const recipientIds = [...recipientIdSet];
    return this.createMany(recipientIds, {
      type: 'exam_published',
      title: 'Kỳ thi mới được đăng chính thức',
      message: `Kỳ thi "${exam.title}" đã được đăng chính thức. Thời gian: ${formatDateTime(exam.startDate || exam.start_date)} - ${formatDateTime(exam.endDate || exam.end_date)}.`,
      examId,
    });
  },

  // Cảnh báo: Ngân hàng đề không đủ câu hỏi để gán cho nhân viên mới
  async notifyExamAssignmentFailed({ exam, employee, department, reason }) {
    const adminsRes = await query(
      `SELECT u.id FROM users u
       JOIN roles r ON u.role_id = r.id
       WHERE r.code = 'admin' AND u.is_active = 1`
    );
    const recipientIds = adminsRes.recordset.map((u) => String(u.id));

    const createdBy = exam.createdBy || exam.created_by;
    if (createdBy && !recipientIds.includes(String(createdBy))) {
      recipientIds.push(String(createdBy));
    }
    if (recipientIds.length === 0) return [];

    const employeeLabel = employee?.fullname || employee?.employeeCode || 'Nhân viên mới';
    const departmentLabel = department?.name || 'phòng ban của nhân viên này';

    return this.createMany(recipientIds, {
      type: 'exam_assignment_failed',
      title: 'Có thí sinh chưa được phát đề thi',
      message: `Thí sinh "${employeeLabel}" (phòng ban "${departmentLabel}") chưa được phát đề cho kỳ thi "${exam.title}" do ngân hàng câu hỏi không đủ số lượng${reason ? ` (${reason})` : ''}. Vui lòng import/bổ sung thêm câu hỏi cho phòng ban này để hệ thống tự động gán đề.`,
      examId: exam.id || exam._id,
    });
  },

  // Lấy danh sách thông báo theo người nhận
  async listForUser(userId, { limit = 30 } = {}) {
    const res = await query(
      `SELECT TOP (@limit) n.*, e.title AS exam_title
       FROM notifications n
       LEFT JOIN exams e ON n.exam_id = e.id
       WHERE n.recipient_user_id = @userId
       ORDER BY n.created_at DESC`,
      { userId, limit }
    );
    return res.recordset.map((r) => ({
      _id: String(r.id),
      id: String(r.id),
      recipientUserId: String(r.recipient_user_id),
      type: r.type,
      title: r.title,
      message: r.message,
      isRead: Boolean(r.is_read),
      createdAt: r.created_at,
      examId: r.exam_id ? {
        _id: String(r.exam_id),
        id: String(r.exam_id),
        title: r.exam_title,
      } : null,
    }));
  },

  // Đếm số lượng thông báo chưa đọc
  async countUnread(userId) {
    const res = await query(
      `SELECT COUNT(1) AS count FROM notifications WHERE recipient_user_id = @userId AND is_read = 0`,
      { userId }
    );
    return res.recordset[0]?.count ?? 0;
  },

  // Đánh dấu 1 thông báo là đã đọc
  async markAsRead(notificationId, userId) {
    const res = await query(
      `UPDATE notifications SET is_read = 1
       OUTPUT INSERTED.*
       WHERE id = @notificationId AND recipient_user_id = @userId`,
      { notificationId, userId }
    );
    return mapRow(res.recordset[0]);
  },

  // Đánh dấu tất cả thông báo của người dùng là đã đọc
  async markAllAsRead(userId) {
    await query(
      `UPDATE notifications SET is_read = 1 WHERE recipient_user_id = @userId AND is_read = 0`,
      { userId }
    );
  },
};
