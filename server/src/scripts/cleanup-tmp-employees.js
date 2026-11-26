/**
 * Script xoá các tài khoản "rác" sinh ra từ những lần import Excel trước khi
 * sửa lỗi đọc nhầm dòng trống/dòng "Ghi chú:" thành dòng nhân viên (mã tạm
 * dạng TMP<số dòng> -> username tmp2, tmp3, ...).
 *
 * Mặc định chạy ở chế độ DRY-RUN: chỉ liệt kê, KHÔNG xoá gì cả.
 * Muốn xoá thật, chạy thêm flag --confirm.
 *
 * Cách chạy (từ thư mục server/):
 *   node src/scripts/cleanup-tmp-employees.js
 *   node src/scripts/cleanup-tmp-employees.js --confirm
 */
import 'dotenv/config';
import { sqlPool, closeSqlPool } from '../db/sql-server.js';
import { query, withTransaction } from '../db/sql-helpers.js';

const CONFIRM = process.argv.includes('--confirm');

async function main() {
  await sqlPool();
  console.log('Đã kết nối SQL Server.');

  // Mã nhân viên rác được sinh tự động có dạng "TMP" + số thứ tự dòng Excel,
  // vd TMP7, TMP8... — khớp không phân biệt hoa/thường để chắc chắn không
  // sót nếu có biến thể chữ thường.
  const { recordset: junkEmployees } = await query(`
    SELECT e.id, e.employee_code, e.user_id, e.fullname
    FROM employees e
    WHERE e.employee_code LIKE 'TMP%'
      AND ISNUMERIC(SUBSTRING(e.employee_code, 4, LEN(e.employee_code))) = 1
  `);

  if (!junkEmployees.length) {
    console.log('Không tìm thấy nhân viên rác nào (mã dạng TMP<số>). Không có gì để xoá.');
    await closeSqlPool();
    return;
  }

  const userIds = junkEmployees.map((e) => e.user_id).filter(Boolean);
  let usernameById = new Map();
  if (userIds.length > 0) {
    const { recordset: users } = await query(`
      SELECT id, username FROM users
      WHERE id IN (${userIds.map((_, i) => `@uid${i}`).join(',')})
    `, Object.fromEntries(userIds.map((id, i) => [`uid${i}`, id])));
    usernameById = new Map(users.map((u) => [String(u.id), u.username]));
  }

  console.log(`Tìm thấy ${junkEmployees.length} nhân viên rác:`);
  for (const emp of junkEmployees) {
    const username = usernameById.get(String(emp.user_id)) || '(không có user)';
    console.log(`  - employeeCode=${emp.employee_code}  username=${username}  fullname="${emp.fullname}"`);
  }

  if (!CONFIRM) {
    console.log(
      '\nĐây là DRY-RUN — chưa xoá gì cả. Chạy lại với flag --confirm để xoá thật:\n' +
        '  node src/scripts/cleanup-tmp-employees.js --confirm',
    );
    await closeSqlPool();
    return;
  }

  const empIds = junkEmployees.map((e) => String(e.id));
  let empDeleteCount = 0;
  let userDeleteCount = 0;

  for (const empId of empIds) {
    await withTransaction(async (txQ) => {
      await txQ('DELETE FROM employee_extra_departments WHERE employee_id = @empId', { empId });
      await txQ('DELETE FROM employees WHERE id = @empId', { empId });
      empDeleteCount++;
    });
  }

  for (const userId of userIds) {
    const uid = String(userId);
    await query('DELETE FROM users WHERE id = @uid', { uid });
    userDeleteCount++;
  }

  console.log(`\nĐã xoá ${empDeleteCount} hồ sơ nhân viên và ${userDeleteCount} tài khoản tương ứng.`);
  await closeSqlPool();
}

main().catch((err) => {
  console.error('Lỗi khi chạy script:', err);
  process.exit(1);
});
