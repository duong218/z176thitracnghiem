/**
 * Service Báo cáo Thống kê & Xuất Dữ liệu Kết quả Thi (Report Service) - Triển khai SQL Server.
 * Hỗ trợ các thống kê tổng quan, theo phòng ban, theo kỳ thi, tra cứu kết quả công khai và xuất báo cáo Excel.
 */

import xlsx from 'xlsx';
import ExcelJS from 'exceljs';
import { query, mapRow, mapRows } from '../db/sql-helpers.js';

const HEADER_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF008BC5' } };
const HEADER_FONT = { bold: true, color: { argb: 'FFFFFFFF' }, size: 11 };
const THIN_BORDER = {
  top: { style: 'thin', color: { argb: 'FFD9D9D9' } },
  left: { style: 'thin', color: { argb: 'FFD9D9D9' } },
  bottom: { style: 'thin', color: { argb: 'FFD9D9D9' } },
  right: { style: 'thin', color: { argb: 'FFD9D9D9' } },
};

function styleHeaderRow(row) {
  row.eachCell((cell) => {
    cell.fill = HEADER_FILL;
    cell.font = HEADER_FONT;
    cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
    cell.border = THIN_BORDER;
  });
  row.height = 24;
}

function styleDataRow(row, { centerCols = [], passedCol = null, passedValue = null } = {}) {
  row.eachCell((cell, colNumber) => {
    cell.border = THIN_BORDER;
    cell.alignment = {
      vertical: 'middle',
      horizontal: centerCols.includes(colNumber) ? 'center' : 'left',
    };
  });
  if (passedCol) {
    const cell = row.getCell(passedCol);
    if (passedValue === true || passedValue === 'Đạt') {
      cell.font = { color: { argb: 'FF15803D' }, bold: true };
    } else if (passedValue === false || passedValue === 'Không đạt') {
      cell.font = { color: { argb: 'FFDC2626' }, bold: true };
    }
  }
}

export const reportService = {
  async getOverviewStats(filters = {}) {
    let where = 'WHERE 1=1';
    const params = {};
    if (filters.topicId) {
      where += ' AND e.topic_id = @topicId';
      params.topicId = filters.topicId;
    }

    const res = await query(
      `SELECT COUNT(r.id) AS totalSubmissions,
              SUM(CASE WHEN r.passed = 1 THEN 1 ELSE 0 END) AS passedCount,
              SUM(CASE WHEN r.passed = 0 THEN 1 ELSE 0 END) AS failedCount,
              AVG(CAST(r.score AS FLOAT)) AS avgScore,
              COUNT(DISTINCT ec.employee_id) AS totalCandidates
       FROM results r
       JOIN exam_attempts ea ON r.exam_attempt_id = ea.id
       JOIN exam_candidates ec ON ea.exam_candidate_id = ec.id
       JOIN exams e ON ec.exam_id = e.id
       ${where}`,
      params
    );

    const stats = res.recordset[0];
    const totalSubmissions = stats?.totalSubmissions ?? 0;
    const passedCount = stats?.passedCount ?? 0;
    const failedCount = stats?.failedCount ?? 0;
    const totalCandidates = stats?.totalCandidates ?? 0;
    const avgScore = Number((stats?.avgScore ?? 0).toFixed(2));
    const passRate = totalSubmissions > 0 ? Number(((passedCount / totalSubmissions) * 100).toFixed(2)) : 0;

    return {
      totalSubmissions,
      totalCandidates,
      passedCount,
      failedCount,
      passRate,
      avgScore,
    };
  },

  async getResultsByDepartment(filters = {}) {
    let where = 'WHERE 1=1';
    const params = {};
    if (filters.topicId) {
      where += ' AND e.topic_id = @topicId';
      params.topicId = filters.topicId;
    }

    const res = await query(
      `SELECT d.id AS _id, d.name AS departmentName,
              COUNT(r.id) AS totalSubmissions,
              COUNT(DISTINCT ec.employee_id) AS totalCandidates,
              SUM(CASE WHEN r.passed = 1 THEN 1 ELSE 0 END) AS passedCount,
              SUM(CASE WHEN r.passed = 0 THEN 1 ELSE 0 END) AS failedCount,
              AVG(CAST(r.score AS FLOAT)) AS avgScore
       FROM results r
       JOIN exam_attempts ea ON r.exam_attempt_id = ea.id
       JOIN exam_candidates ec ON ea.exam_candidate_id = ec.id
       JOIN employees emp ON ec.employee_id = emp.id
       JOIN departments d ON ISNULL(ea.department_id, emp.department_id) = d.id
       JOIN exams e ON ec.exam_id = e.id
       ${where}
       GROUP BY d.id, d.name
       ORDER BY d.name ASC`,
      params
    );

    return res.recordset.map((r) => {
      const total = r.totalSubmissions || 0;
      const passed = r.passedCount || 0;
      const passRate = total > 0 ? Number(((passed / total) * 100).toFixed(2)) : 0;
      return {
        _id: String(r._id),
        departmentName: r.departmentName,
        totalSubmissions: total,
        totalCandidates: r.totalCandidates || 0,
        passedCount: passed,
        failedCount: r.failedCount || 0,
        passRate,
        avgScore: Number((r.avgScore || 0).toFixed(2)),
      };
    });
  },

  async getResultsByExam() {
    const res = await query(
      `SELECT e.id AS _id, e.title AS examTitle, ISNULL(t.name, N'Chưa gán chủ đề') AS topicName,
              COUNT(r.id) AS totalSubmissions,
              COUNT(DISTINCT ec.employee_id) AS totalCandidates,
              SUM(CASE WHEN r.passed = 1 THEN 1 ELSE 0 END) AS passedCount,
              SUM(CASE WHEN r.passed = 0 THEN 1 ELSE 0 END) AS failedCount,
              AVG(CAST(r.score AS FLOAT)) AS avgScore
       FROM results r
       JOIN exam_attempts ea ON r.exam_attempt_id = ea.id
       JOIN exam_candidates ec ON ea.exam_candidate_id = ec.id
       JOIN exams e ON ec.exam_id = e.id
       LEFT JOIN topics t ON e.topic_id = t.id
       GROUP BY e.id, e.title, t.name
       ORDER BY e.title ASC`
    );

    return res.recordset.map((r) => {
      const total = r.totalSubmissions || 0;
      const passed = r.passedCount || 0;
      const passRate = total > 0 ? Number(((passed / total) * 100).toFixed(2)) : 0;
      return {
        _id: String(r._id),
        examTitle: r.examTitle,
        topicName: r.topicName,
        totalSubmissions: total,
        totalCandidates: r.totalCandidates || 0,
        passedCount: passed,
        failedCount: r.failedCount || 0,
        passRate,
        avgScore: Number((r.avgScore || 0).toFixed(2)),
      };
    });
  },

  async getTopicOptions() {
    const res = await query(
      `SELECT t.id AS _id, t.name, COUNT(r.id) AS totalSubmissions
       FROM results r
       JOIN exam_attempts ea ON r.exam_attempt_id = ea.id
       JOIN exam_candidates ec ON ea.exam_candidate_id = ec.id
       JOIN exams e ON ec.exam_id = e.id
       JOIN topics t ON e.topic_id = t.id
       GROUP BY t.id, t.name
       ORDER BY t.name ASC`
    );
    return res.recordset.map((r) => ({ _id: String(r._id), name: r.name, totalSubmissions: r.totalSubmissions }));
  },

  async getExamOptions() {
    const res = await query(
      `SELECT DISTINCT e.id AS _id, e.title, e.created_at
       FROM exams e
       JOIN exam_candidates ec ON ec.exam_id = e.id
       ORDER BY e.created_at DESC`
    );
    return res.recordset.map((r) => ({ _id: String(r._id), id: String(r._id), title: r.title }));
  },

  async getPublicResultsByDepartment() {
    const res = await query(
      `SELECT d.name AS departmentName,
              COUNT(r.id) AS totalSubmissions,
              SUM(CASE WHEN r.passed = 1 THEN 1 ELSE 0 END) AS passedCount
       FROM results r
       JOIN exam_attempts ea ON r.exam_attempt_id = ea.id
       JOIN exam_candidates ec ON ea.exam_candidate_id = ec.id
       JOIN employees emp ON ec.employee_id = emp.id
       JOIN departments d ON ISNULL(ea.department_id, emp.department_id) = d.id
       GROUP BY d.name`
    );

    const list = res.recordset.map((r) => {
      const total = r.totalSubmissions || 0;
      const passed = r.passedCount || 0;
      const passRate = total > 0 ? Number(((passed / total) * 100).toFixed(2)) : 0;
      return { departmentName: r.departmentName, totalSubmissions: total, passRate };
    });
    return list.sort((a, b) => b.passRate - a.passRate);
  },

  async lookupPublicResult(term) {
    const q = String(term ?? '').trim();
    if (!q) return [];

    const res = await query(
      `SELECT TOP 5 emp.fullname, emp.employee_code, d.name AS departmentName,
              r.score, r.total_questions, r.passed, ea.submitted_at
       FROM results r
       JOIN exam_attempts ea ON r.exam_attempt_id = ea.id
       JOIN exam_candidates ec ON ea.exam_candidate_id = ec.id
       JOIN employees emp ON ec.employee_id = emp.id
       JOIN departments d ON ISNULL(ea.department_id, emp.department_id) = d.id
       WHERE emp.fullname = @term OR emp.employee_code = @term
       ORDER BY r.created_at DESC`,
      { term: q }
    );

    return res.recordset.map((item) => ({
      fullname: item.fullname,
      employeeCode: item.employee_code || null,
      departmentName: item.departmentName,
      score: Number(item.score),
      totalQuestions: item.total_questions,
      passed: Boolean(item.passed),
      submittedAt: item.submitted_at,
    }));
  },

  async getDetailedResults(filters = {}) {
    const page = parseInt(filters.page, 10) || 1;
    const limit = parseInt(filters.limit, 10) || 20;
    const offset = (page - 1) * limit;

    const absent = filters.passed === 'absent';
    let where = 'WHERE 1=1';
    const params = { limit, offset };

    if (filters.departmentId) {
      where += ' AND d.id = @deptId';
      params.deptId = filters.departmentId;
    }
    if (filters.examId) {
      where += ' AND e.id = @examId';
      params.examId = filters.examId;
    }
    if (filters.search?.trim()) {
      where += ' AND emp.fullname LIKE @search';
      params.search = `%${filters.search.trim()}%`;
    }

    if (absent) {
      where += ` AND emp.is_active = 1
                 AND NOT EXISTS (
                   SELECT 1 FROM exam_attempts ea
                   WHERE ea.exam_candidate_id = ec.id AND ea.attempt_type = 'official'
                 )`;

      const countRes = await query(
        `SELECT COUNT(1) AS total
         FROM exam_candidates ec
         JOIN employees emp ON ec.employee_id = emp.id
         LEFT JOIN exam_codes code ON ec.exam_code_id = code.id
         JOIN departments d ON ISNULL(code.department_id, emp.department_id) = d.id
         JOIN exams e ON ec.exam_id = e.id
         ${where}`,
        params
      );
      const total = countRes.recordset[0]?.total ?? 0;

      const dataRes = await query(
        `SELECT ec.id AS _id, emp.fullname AS employeeName, d.id AS departmentId, d.name AS departmentName, e.title AS examTitle
         FROM exam_candidates ec
         JOIN employees emp ON ec.employee_id = emp.id
         LEFT JOIN exam_codes code ON ec.exam_code_id = code.id
         JOIN departments d ON ISNULL(code.department_id, emp.department_id) = d.id
         JOIN exams e ON ec.exam_id = e.id
         ${where}
         ORDER BY e.created_at DESC, emp.fullname ASC
         OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY`,
        params
      );

      const formatted = dataRes.recordset.map((item) => ({
        _id: String(item._id),
        examCandidateId: String(item._id),
        employeeName: item.employeeName,
        departmentId: String(item.departmentId),
        departmentName: item.departmentName,
        examTitle: item.examTitle,
        score: null,
        passed: null,
        submittedAt: null,
        notTaken: true,
      }));

      return {
        data: formatted,
        pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
      };
    }

    if (filters.passed !== undefined && filters.passed !== '') {
      where += ' AND r.passed = @passed';
      params.passed = (filters.passed === 'true') ? 1 : 0;
    }
    if (filters.startDate) {
      where += ' AND r.created_at >= @startDate';
      params.startDate = new Date(filters.startDate);
    }
    if (filters.endDate) {
      const end = new Date(filters.endDate);
      end.setHours(23, 59, 59, 999);
      where += ' AND r.created_at <= @endDate';
      params.endDate = end;
    }

    const countRes = await query(
      `SELECT COUNT(1) AS total
       FROM results r
       JOIN exam_attempts ea ON r.exam_attempt_id = ea.id
       JOIN exam_candidates ec ON ea.exam_candidate_id = ec.id
       JOIN employees emp ON ec.employee_id = emp.id
       JOIN departments d ON ISNULL(ea.department_id, emp.department_id) = d.id
       JOIN exams e ON ec.exam_id = e.id
       ${where}`,
      params
    );
    const total = countRes.recordset[0]?.total ?? 0;

    const dataRes = await query(
      `SELECT r.id AS _id, ec.id AS candidateId, emp.fullname AS employeeName,
              d.id AS departmentId, d.name AS departmentName, e.title AS examTitle,
              r.score, r.passed, ea.submitted_at
       FROM results r
       JOIN exam_attempts ea ON r.exam_attempt_id = ea.id
       JOIN exam_candidates ec ON ea.exam_candidate_id = ec.id
       JOIN employees emp ON ec.employee_id = emp.id
       JOIN departments d ON ISNULL(ea.department_id, emp.department_id) = d.id
       JOIN exams e ON ec.exam_id = e.id
       ${where}
       ORDER BY r.created_at DESC
       OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY`,
      params
    );

    const formatted = dataRes.recordset.map((item) => ({
      _id: String(item._id),
      examCandidateId: String(item.candidateId),
      employeeName: item.employeeName,
      departmentId: String(item.departmentId),
      departmentName: item.departmentName,
      examTitle: item.examTitle,
      score: Number(item.score),
      passed: Boolean(item.passed),
      submittedAt: item.submitted_at,
    }));

    return {
      data: formatted,
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    };
  },

  async exportDetailedResultsExcel(filters = {}) {
    const absent = filters.passed === 'absent';
    let where = 'WHERE 1=1';
    const params = {};

    if (filters.departmentId) {
      where += ' AND d.id = @deptId';
      params.deptId = filters.departmentId;
    }
    if (filters.examId) {
      where += ' AND e.id = @examId';
      params.examId = filters.examId;
    }
    if (filters.search?.trim()) {
      where += ' AND emp.fullname LIKE @search';
      params.search = `%${filters.search.trim()}%`;
    }

    let rows = [];
    if (absent) {
      where += ` AND emp.is_active = 1
                 AND NOT EXISTS (
                   SELECT 1 FROM exam_attempts ea
                   WHERE ea.exam_candidate_id = ec.id AND ea.attempt_type = 'official'
                 )`;
      const dataRes = await query(
        `SELECT emp.fullname, d.name AS departmentName, e.title AS examTitle
         FROM exam_candidates ec
         JOIN employees emp ON ec.employee_id = emp.id
         LEFT JOIN exam_codes code ON ec.exam_code_id = code.id
         JOIN departments d ON ISNULL(code.department_id, emp.department_id) = d.id
         JOIN exams e ON ec.exam_id = e.id
         ${where}
         ORDER BY e.created_at DESC, emp.fullname ASC`,
        params
      );
      rows = dataRes.recordset.map((r, i) => ({
        'STT': i + 1,
        'Họ và tên': r.fullname,
        'Phòng ban': r.departmentName,
        'Bài thi': r.examTitle,
        'Điểm': '',
        'Kết quả': 'Chưa thi',
        'Ngày nộp': '',
      }));
    } else {
      if (filters.passed !== undefined && filters.passed !== '') {
        where += ' AND r.passed = @passed';
        params.passed = (filters.passed === 'true') ? 1 : 0;
      }
      if (filters.startDate) {
        where += ' AND r.created_at >= @startDate';
        params.startDate = new Date(filters.startDate);
      }
      if (filters.endDate) {
        const end = new Date(filters.endDate);
        end.setHours(23, 59, 59, 999);
        where += ' AND r.created_at <= @endDate';
        params.endDate = end;
      }

      const dataRes = await query(
        `SELECT emp.fullname, d.name AS departmentName, e.title AS examTitle, r.score, r.passed, ea.submitted_at
         FROM results r
         JOIN exam_attempts ea ON r.exam_attempt_id = ea.id
         JOIN exam_candidates ec ON ea.exam_candidate_id = ec.id
         JOIN employees emp ON ec.employee_id = emp.id
         JOIN departments d ON ISNULL(ea.department_id, emp.department_id) = d.id
         JOIN exams e ON ec.exam_id = e.id
         ${where}
         ORDER BY r.created_at DESC`,
        params
      );
      rows = dataRes.recordset.map((r, i) => ({
        'STT': i + 1,
        'Họ và tên': r.fullname,
        'Phòng ban': r.departmentName,
        'Bài thi': r.examTitle,
        'Điểm': Number(r.score),
        'Kết quả': r.passed ? 'Đạt' : 'Không đạt',
        'Ngày nộp': r.submitted_at ? new Date(r.submitted_at).toLocaleString('vi-VN') : '',
      }));
    }

    const worksheet = xlsx.utils.json_to_sheet(rows);
    worksheet['!cols'] = [5, 25, 20, 30, 10, 15, 20].map((w) => ({ wch: w }));
    const workbook = xlsx.utils.book_new();
    xlsx.utils.book_append_sheet(workbook, worksheet, 'Ket_qua_thi');
    return xlsx.write(workbook, { type: 'buffer', bookType: 'xlsx' });
  },

  async exportResultsByExamExcel() {
    const summary = await this.getResultsByExam();
    const detailRes = await query(
      `SELECT e.title AS examTitle, ISNULL(t.name, N'Chưa gán chủ đề') AS topicName,
              emp.fullname, d.name AS departmentName, r.score, r.passed, ea.submitted_at
       FROM results r
       JOIN exam_attempts ea ON r.exam_attempt_id = ea.id
       JOIN exam_candidates ec ON ea.exam_candidate_id = ec.id
       JOIN employees emp ON ec.employee_id = emp.id
       JOIN departments d ON ISNULL(ea.department_id, emp.department_id) = d.id
       JOIN exams e ON ec.exam_id = e.id
       LEFT JOIN topics t ON e.topic_id = t.id
       ORDER BY e.title ASC, r.created_at DESC`
    );

    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'Z176 - He thong thi noi bo';
    workbook.created = new Date();

    const sumSheet = workbook.addWorksheet('Tong_hop', { views: [{ state: 'frozen', ySplit: 1 }] });
    sumSheet.columns = [
      { header: 'Bài thi', key: 'examTitle', width: 32 },
      { header: 'Chủ đề', key: 'topicName', width: 24 },
      { header: 'Số thí sinh', key: 'totalCandidates', width: 12 },
      { header: 'Số lượt nộp', key: 'totalSubmissions', width: 12 },
      { header: 'Đạt', key: 'passedCount', width: 10 },
      { header: 'Không đạt', key: 'failedCount', width: 12 },
      { header: 'Tỷ lệ Đạt (%)', key: 'passRate', width: 14 },
      { header: 'Điểm TB', key: 'avgScore', width: 12 },
    ];
    styleHeaderRow(sumSheet.getRow(1));
    summary.forEach((item) => {
      const row = sumSheet.addRow(item);
      styleDataRow(row, { centerCols: [3, 4, 5, 6, 7, 8] });
      row.getCell('passedCount').font = { color: { argb: 'FF15803D' }, bold: true };
      row.getCell('failedCount').font = { color: { argb: 'FFDC2626' }, bold: true };
    });
    sumSheet.autoFilter = { from: 'A1', to: `H${summary.length + 1}` };

    const detailSheet = workbook.addWorksheet('Chi_tiet', { views: [{ state: 'frozen', ySplit: 1 }] });
    detailSheet.columns = [
      { header: 'STT', key: 'stt', width: 6 },
      { header: 'Bài thi', key: 'examTitle', width: 30 },
      { header: 'Chủ đề', key: 'topicName', width: 22 },
      { header: 'Họ và tên', key: 'fullname', width: 25 },
      { header: 'Phòng ban', key: 'departmentName', width: 20 },
      { header: 'Điểm', key: 'score', width: 10 },
      { header: 'Kết quả', key: 'passedText', width: 14 },
      { header: 'Ngày nộp', key: 'submittedAt', width: 20 },
    ];
    styleHeaderRow(detailSheet.getRow(1));
    detailRes.recordset.forEach((item, index) => {
      const row = detailSheet.addRow({
        stt: index + 1,
        examTitle: item.examTitle,
        topicName: item.topicName,
        fullname: item.fullname,
        departmentName: item.departmentName,
        score: Number(item.score),
        passedText: item.passed ? 'Đạt' : 'Không đạt',
        submittedAt: item.submitted_at ? new Date(item.submitted_at).toLocaleString('vi-VN') : '',
      });
      styleDataRow(row, { centerCols: [1, 6, 7, 8], passedCol: 7, passedValue: item.passed });
    });
    detailSheet.autoFilter = { from: 'A1', to: `H${detailRes.recordset.length + 1}` };

    return workbook.xlsx.writeBuffer();
  },

  async getMyResults(userId) {
    const empRes = await query(
      `SELECT e.id, e.fullname, e.employee_code, d.name AS department_name
       FROM employees e
       LEFT JOIN departments d ON e.department_id = d.id
       WHERE e.user_id = @userId`,
      { userId }
    );
    const employee = mapRow(empRes.recordset[0]);
    if (!employee) return { employee: null, results: [] };

    const extraRes = await query(
      `SELECT d.id AS _id, d.name
       FROM employee_extra_departments eed
       JOIN departments d ON eed.department_id = d.id
       WHERE eed.employee_id = @empId`,
      { empId: employee.id }
    );

    const res = await query(
      `SELECT r.id AS _id, e.id AS examId, e.title AS examTitle,
              r.score, r.correct_count, r.total_questions, r.passed,
              ea.submitted_at, ea.started_at, d.name AS department_name
       FROM results r
       JOIN exam_attempts ea ON r.exam_attempt_id = ea.id
       JOIN exam_candidates ec ON ea.exam_candidate_id = ec.id
       JOIN exams e ON ec.exam_id = e.id
       JOIN employees emp ON ec.employee_id = emp.id
       JOIN departments d ON ISNULL(ea.department_id, emp.department_id) = d.id
       WHERE ec.employee_id = @empId
       ORDER BY r.created_at DESC`,
      { empId: employee.id }
    );

    const results = res.recordset.map((item) => ({
      _id: String(item._id),
      examId: String(item.examId),
      examTitle: item.examTitle,
      score: Number(item.score),
      correctCount: item.correct_count,
      totalQuestions: item.total_questions,
      passed: Boolean(item.passed),
      submittedAt: item.submitted_at,
      startedAt: item.started_at,
      departmentName: item.department_name ?? null,
    }));

    return {
      employee: {
        fullname: employee.fullname,
        employeeCode: employee.employee_code || null,
        departmentName: employee.department_name || null,
        extraDepartments: extraRes.recordset.map((d) => ({ _id: String(d._id), name: d.name })),
      },
      results,
    };
  },
};

export const absentPipeline = () => [];
