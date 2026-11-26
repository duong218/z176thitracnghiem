/**
 * Script dọn các lượt thi CHÍNH THỨC bị tạo đôi do lỗi cũ (2 request /start chạy song song -> 1 lần ngồi thi sinh ra
 * 2 ExamAttempt, nộp xong ra 2 kết quả).
 *
 * Cách nhận diện: cùng 1 thí sinh (ExamCandidate), các lượt thi chính thức có `startedAt` cách nhau <= 30 giây được coi
 * là cùng 1 lần ngồi thi. Một lần thi thật không thể bắt đầu lại trong vòng 30 giây (mỗi lượt kéo dài nhiều phút và
 * lượt mới chỉ có sau khi Người duyệt đề cấp thêm).
 *
 * Trong mỗi nhóm trùng, GIỮ 1 lượt theo thứ tự ưu tiên: có Result > đã nộp > hết giờ > đang dở; hòa thì lấy lượt bắt
 * đầu sớm nhất. Các lượt còn lại bị xóa cùng Result, CandidateAnswer, AttemptQuestion của nó.
 *
 * Script KHÔNG sửa `extraAttemptsGranted` — số lượt thi còn lại của thí sinh sau khi dọn được in ra để bạn tự cấp/điều
 * chỉnh bằng chức năng "Cấp lại lượt thi".
 *
 * Mặc định chạy DRY-RUN: chỉ liệt kê, KHÔNG xóa gì. Muốn xóa thật thêm --confirm.
 * NÊN sao lưu DB trước (npm run backup).
 *
 * Cách chạy (từ thư mục server/):
 *   node src/scripts/cleanup-duplicate-attempts.js
 *   node src/scripts/cleanup-duplicate-attempts.js --confirm
 */
import 'dotenv/config';
import { fileURLToPath } from 'node:url';
import { sqlPool, closeSqlPool } from '../db/sql-server.js';
import { query, withTransaction } from '../db/sql-helpers.js';
const CONFIRM = process.argv.includes('--confirm');

const SAME_SITTING_WINDOW_MS = 30_000; // các lượt bắt đầu cách nhau <= mức này = cùng 1 lần ngồi thi
const MAX_OFFICIAL_ATTEMPTS = 1; // phải khớp exam-attempt.service.js

const STATUS_RANK = { submitted: 0, expired: 1, in_progress: 2 };

/**
 * Hàm thuần (không đụng DB) để dễ kiểm thử.
 * attempts: [{ _id, examCandidateId, startedAt, status }], resultAttemptIds: Set<string>
 * Trả về các nhóm trùng: [{ examCandidateId, keep, remove: [...] }]
 */
export function findDuplicateGroups(attempts, resultAttemptIds) {
  const byCandidate = new Map();
  for (const a of attempts) {
    const key = String(a.examCandidateId);
    if (!byCandidate.has(key)) byCandidate.set(key, []);
    byCandidate.get(key).push(a);
  }

  const groups = [];
  for (const [candidateId, list] of byCandidate) {
    list.sort((x, y) => new Date(x.startedAt) - new Date(y.startedAt));

    // Gom thành các cụm: lượt sau thuộc cụm hiện tại nếu bắt đầu trong vòng WINDOW kể từ lượt ĐẦU của cụm
    const clusters = [];
    for (const a of list) {
      const last = clusters[clusters.length - 1];
      if (last && new Date(a.startedAt) - new Date(last[0].startedAt) <= SAME_SITTING_WINDOW_MS) {
        last.push(a);
      } else {
        clusters.push([a]);
      }
    }

    for (const cluster of clusters) {
      if (cluster.length < 2) continue;
      const ranked = [...cluster].sort((x, y) => {
        const rx = resultAttemptIds.has(String(x._id)) ? 0 : 1;
        const ry = resultAttemptIds.has(String(y._id)) ? 0 : 1;
        if (rx !== ry) return rx - ry;
        const sx = STATUS_RANK[x.status] ?? 9;
        const sy = STATUS_RANK[y.status] ?? 9;
        if (sx !== sy) return sx - sy;
        return new Date(x.startedAt) - new Date(y.startedAt);
      });
      groups.push({ examCandidateId: candidateId, keep: ranked[0], remove: ranked.slice(1) });
    }
  }
  return groups;
}

const fmt = (d) => (d ? new Date(d).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' }) : '-');

// Thông tin thí sinh + kỳ thi để in ra màn hình
async function loadCandidates(ids) {
  const params = Object.fromEntries(ids.map((id, i) => [`id${i}`, id]));
  const { recordset } = await query(
    `SELECT ec.id, ec.extra_attempts_granted AS extraAttemptsGranted, e.fullname, e.employee_code AS employeeCode, x.title
       FROM exam_candidates ec
       JOIN employees e ON e.id = ec.employee_id
       JOIN exams x ON x.id = ec.exam_id
      WHERE ec.id IN (${Object.keys(params).map((k) => `@${k}`).join(',')})`,
    params,
  );
  return recordset;
}

async function main() {
  await sqlPool();
  console.log(`Đã kết nối SQL Server. Chế độ: ${CONFIRM ? 'XÓA THẬT (--confirm)' : 'DRY-RUN (không xóa gì)'}\n`);

  const { recordset: attempts } = await query(`
    SELECT id as _id, exam_candidate_id as examCandidateId, started_at as startedAt, submitted_at as submittedAt, status
    FROM exam_attempts
    WHERE attempt_type = 'official'
  `);
  const { recordset: results } = await query(`
    SELECT exam_attempt_id as examAttemptId, score, passed
    FROM results
  `);
  const resultByAttempt = new Map(results.map((r) => [String(r.examAttemptId), r]));

  const groups = findDuplicateGroups(attempts, new Set(resultByAttempt.keys()));

  if (groups.length === 0) {
    console.log('Không có lượt thi trùng nào cần dọn.');
  } else {
    const candById = new Map((await loadCandidates(groups.map((g) => g.examCandidateId))).map((c) => [String(c.id), c]));

    console.log(`Tìm thấy ${groups.length} lần ngồi thi bị tạo đôi:\n`);
    for (const g of groups) {
      const c = candById.get(g.examCandidateId);
      const name = c?.fullname ?? '(không rõ)';
      const code = c?.employeeCode ?? '';
      console.log(`• ${name} ${code ? `(${code})` : ''} — kỳ thi: ${c?.title ?? '(không rõ)'}`);
      const describe = (a) => {
        const r = resultByAttempt.get(String(a._id));
        return `${a._id} | bắt đầu ${fmt(a.startedAt)} | ${a.status} | ${r ? `điểm ${r.score}` : 'chưa có kết quả'}`;
      };
      console.log(`    GIỮ : ${describe(g.keep)}`);
      for (const a of g.remove) console.log(`    XÓA : ${describe(a)}`);
      const differ = g.remove.some((a) => {
        const r = resultByAttempt.get(String(a._id));
        const rk = resultByAttempt.get(String(g.keep._id));
        return r && rk && r.score !== rk.score;
      });
      if (differ) console.log('    ⚠ Điểm giữa các lượt trùng KHÁC nhau — kiểm tra kỹ trước khi xóa.');
    }

    if (CONFIRM) {
      const removeIds = groups.flatMap((g) => g.remove.map((a) => a._id));
      // Xóa bảng con trước, tất cả trong 1 transaction
      await withTransaction(async (txQuery) => {
        for (const attemptId of removeIds) {
          for (const sql of [
            'DELETE FROM results WHERE exam_attempt_id = @attemptId',
            'DELETE FROM candidate_answer_selections WHERE candidate_answer_id IN (SELECT id FROM candidate_answers WHERE exam_attempt_id = @attemptId)',
            'DELETE FROM candidate_answers WHERE exam_attempt_id = @attemptId',
            'DELETE FROM attempt_question_answers WHERE attempt_question_id IN (SELECT id FROM attempt_questions WHERE exam_attempt_id = @attemptId)',
            'DELETE FROM attempt_questions WHERE exam_attempt_id = @attemptId',
            'DELETE FROM exam_attempts WHERE id = @attemptId',
          ]) await txQuery(sql, { attemptId });
        }
      });
      console.log(`\nĐã xóa ${removeIds.length} lượt thi thừa (kèm kết quả/đáp án).`);
    } else {
      const n = groups.reduce((s, g) => s + g.remove.length, 0);
      console.log(`\n[DRY-RUN] Sẽ xóa ${n} lượt thi thừa (kèm kết quả/đáp án của chúng). Chạy lại với --confirm để xóa thật.`);
    }
  }

  // ── Số lượt thi còn lại của các thí sinh bị ảnh hưởng (sau khi dọn) ──────────────────────────────
  if (groups.length > 0) {
    const removedSet = new Set(groups.flatMap((g) => g.remove.map((a) => String(a._id))));
    const affectedIds = [...new Set(groups.map((g) => g.examCandidateId))];
    const cands = await loadCandidates(affectedIds);
    console.log('\nSố lượt thi sau khi dọn (để bạn cấp thêm nếu cần):');
    for (const c of cands) {
      const used = attempts.filter(
        (a) =>
          String(a.examCandidateId) === String(c.id) && a.status !== 'in_progress' && !removedSet.has(String(a._id)),
      ).length;
      const max = MAX_OFFICIAL_ATTEMPTS + (c.extraAttemptsGranted ?? 0);
      console.log(
        `  - ${c.fullname ?? c.id}: đã dùng ${used}, tối đa ${max} (đã cấp thêm ${c.extraAttemptsGranted ?? 0}) -> còn ${Math.max(0, max - used)} lượt`,
      );
    }
  }

  // ── Kiểm tra thí sinh còn >1 lượt ĐANG DỞ (chặn việc tạo chỉ mục duy nhất) ──────────────────────
  const removedAll = new Set(groups.flatMap((g) => g.remove.map((a) => String(a._id))));
  const inProgressByCand = new Map();
  for (const a of attempts) {
    if (a.status !== 'in_progress' || removedAll.has(String(a._id))) continue;
    const k = String(a.examCandidateId);
    inProgressByCand.set(k, (inProgressByCand.get(k) ?? 0) + 1);
  }
  const stuck = [...inProgressByCand].filter(([, n]) => n > 1);
  if (stuck.length > 0) {
    console.log(`\n⚠ Còn ${stuck.length} thí sinh có >1 lượt ĐANG DỞ (không tự dọn được, cần xử lý tay trước khi tạo chỉ mục):`);
    for (const [candId, n] of stuck) console.log(`  - examCandidateId=${candId}: ${n} lượt đang dở`);
  }

  await closeSqlPool();
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(async (err) => {
    console.error('Lỗi:', err);
    await closeSqlPool().catch(() => {});
    process.exit(1);
  });
}