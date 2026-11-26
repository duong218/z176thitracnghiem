/**
 * Service Quản lý Tài liệu Ôn tập (Study Document Service) - Triển khai SQL Server.
 * Xử lý lưu trữ, truy vấn tài liệu theo phạm vi (Chung / Riêng phòng ban) và kiểm soát quyền truy cập file.
 */

import fs from 'fs';
import { query, mapRow, mapRows } from '../db/sql-helpers.js';
import { DOCUMENT_SCOPE } from '../models/constants.js';
import { ApiError, assertFound } from '../utils/api-error.js';

async function getCandidateDepartmentIds(userId) {
  const empRes = await query(
    `SELECT e.id, e.department_id FROM employees e WHERE e.user_id = @userId`,
    { userId }
  );
  if (!empRes.recordset.length) return [];
  const emp = empRes.recordset[0];
  const ids = [];
  if (emp.department_id) ids.push(String(emp.department_id));

  const extraRes = await query(
    `SELECT department_id FROM employee_extra_departments WHERE employee_id = @empId`,
    { empId: emp.id }
  );
  for (const r of extraRes.recordset) {
    if (r.department_id) ids.push(String(r.department_id));
  }
  return [...new Set(ids)];
}

export async function listDocumentsForStaff({ topicId } = {}) {
  let where = 'WHERE sd.is_active = 1';
  const params = {};
  if (topicId) {
    where += ' AND sd.topic_id = @topicId';
    params.topicId = topicId;
  }

  const res = await query(
    `SELECT sd.*, t.name AS topic_name, d.name AS department_name, u.username AS uploaded_by_username
     FROM study_documents sd
     JOIN topics t ON sd.topic_id = t.id
     LEFT JOIN departments d ON sd.department_id = d.id
     LEFT JOIN users u ON sd.uploaded_by = u.id
     ${where}
     ORDER BY sd.created_at DESC`,
    params
  );

  return res.recordset.map((r) => ({
    _id: String(r.id),
    id: String(r.id),
    title: r.title,
    filePath: r.file_path,
    originalFileName: r.original_file_name,
    mimeType: r.mime_type,
    scope: r.scope,
    isActive: Boolean(r.is_active),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    topicId: { _id: String(r.topic_id), id: String(r.topic_id), name: r.topic_name },
    departmentId: r.department_id ? { _id: String(r.department_id), id: String(r.department_id), name: r.department_name } : null,
    uploadedBy: r.uploaded_by ? { _id: String(r.uploaded_by), id: String(r.uploaded_by), username: r.uploaded_by_username } : null,
  }));
}

export async function listDocumentsForCandidate(userId, { topicId } = {}) {
  const departmentIds = await getCandidateDepartmentIds(userId);
  let where = 'WHERE sd.is_active = 1';
  const params = {};

  if (departmentIds.length > 0) {
    const inClauses = departmentIds.map((_, i) => `@d_${i}`);
    departmentIds.forEach((id, i) => { params[`d_${i}`] = id; });
    where += ` AND (sd.scope = 'Common' OR (sd.scope = 'DepartmentSpecific' AND sd.department_id IN (${inClauses.join(',')})))`;
  } else {
    where += ` AND sd.scope = 'Common'`;
  }

  if (topicId) {
    where += ' AND sd.topic_id = @topicId';
    params.topicId = topicId;
  }

  const res = await query(
    `SELECT sd.*, t.name AS topic_name
     FROM study_documents sd
     JOIN topics t ON sd.topic_id = t.id
     ${where}
     ORDER BY sd.created_at DESC`,
    params
  );

  return res.recordset.map((r) => ({
    _id: String(r.id),
    id: String(r.id),
    title: r.title,
    filePath: r.file_path,
    originalFileName: r.original_file_name,
    mimeType: r.mime_type,
    scope: r.scope,
    isActive: Boolean(r.is_active),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    topicId: { _id: String(r.topic_id), id: String(r.topic_id), name: r.topic_name },
  }));
}

export async function createDocument({ topicId, title, scope, departmentId, file }, uploadedBy) {
  if (!topicId) throw new ApiError(400, 'Vui lòng chọn chủ đề', 'DOCUMENT_TOPIC_REQUIRED');

  const topicRes = await query('SELECT id FROM topics WHERE id = @id', { id: topicId });
  assertFound(topicRes.recordset[0], 'Không tìm thấy chủ đề', 'TOPIC_NOT_FOUND');

  const resolvedScope =
    scope === DOCUMENT_SCOPE.DEPARTMENT_SPECIFIC
      ? DOCUMENT_SCOPE.DEPARTMENT_SPECIFIC
      : DOCUMENT_SCOPE.COMMON;

  if (resolvedScope === DOCUMENT_SCOPE.DEPARTMENT_SPECIFIC && !departmentId) {
    throw new ApiError(400, 'Vui lòng chọn phòng ban cho tài liệu riêng', 'DOCUMENT_DEPARTMENT_REQUIRED');
  }

  const insRes = await query(
    `INSERT INTO study_documents (topic_id, title, file_path, original_file_name, mime_type, scope, department_id, uploaded_by, is_active)
     OUTPUT INSERTED.*
     VALUES (@topicId, @title, @filePath, @originalFileName, @mimeType, @scope, @deptId, @uploadedBy, 1)`,
    {
      topicId,
      title: title?.trim() || file.originalname,
      filePath: file.path,
      originalFileName: file.originalname,
      mimeType: file.mimetype,
      scope: resolvedScope,
      deptId: resolvedScope === DOCUMENT_SCOPE.DEPARTMENT_SPECIFIC ? departmentId : null,
      uploadedBy,
    }
  );

  return mapRow(insRes.recordset[0]);
}

export async function deactivateDocument(id, requester) {
  const docRes = await query('SELECT * FROM study_documents WHERE id = @id', { id });
  const doc = mapRow(docRes.recordset[0]);
  assertFound(doc, 'Không tìm thấy tài liệu', 'DOCUMENT_NOT_FOUND');

  const isOwner = String(doc.uploadedBy) === String(requester.userId);
  const isAdmin = requester.roleCode === 'admin';
  if (!isOwner && !isAdmin) {
    throw new ApiError(403, 'Bạn không có quyền xóa tài liệu này', 'DOCUMENT_FORBIDDEN');
  }

  await query('UPDATE study_documents SET is_active = 0, updated_at = SYSUTCDATETIME() WHERE id = @id', { id });
  return { id: String(doc.id), isActive: false };
}

export async function getDocumentForAccess(id, requester) {
  const docRes = await query('SELECT * FROM study_documents WHERE id = @id', { id });
  const doc = mapRow(docRes.recordset[0]);
  assertFound(doc, 'Không tìm thấy tài liệu', 'DOCUMENT_NOT_FOUND');

  if (!doc.isActive) {
    throw new ApiError(404, 'Tài liệu không còn tồn tại', 'DOCUMENT_NOT_FOUND');
  }

  if (requester.roleCode === 'candidate' && doc.scope === DOCUMENT_SCOPE.DEPARTMENT_SPECIFIC) {
    const departmentIds = await getCandidateDepartmentIds(requester.userId);
    if (!doc.departmentId || !departmentIds.includes(String(doc.departmentId))) {
      throw new ApiError(403, 'Bạn không có quyền truy cập tài liệu này', 'DOCUMENT_FORBIDDEN');
    }
  }

  if (!fs.existsSync(doc.filePath)) {
    throw new ApiError(404, 'File không còn tồn tại trên máy chủ', 'DOCUMENT_FILE_MISSING');
  }

  return doc;
}
