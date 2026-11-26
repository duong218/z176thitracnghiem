# mock-data/ — Dữ liệu GIẢ dùng khi làm việc với AI

> 🔒 Xem AGENT_RULES.md mục 1 trước khi đọc file này.

## Quy tắc

1. **Toàn bộ dữ liệu trong thư mục này là bịa (fictional)** — tên người, đơn vị, câu hỏi, đáp án đều không có thật. Không có bất kỳ liên hệ nào với nhân sự/dữ liệu thật của Z176.
2. AI (Claude, Cursor, Antigravity, Codex...) chỉ được đọc dữ liệu mẫu **từ đây** khi cần ví dụ để code/test — không bao giờ được cấp dữ liệu thật, kể cả khi Dương lỡ paste vào chat (xem AGENT_RULES.md mục 1.4).
3. Khi seed database cho môi trường dev/demo, dùng đúng các file này — không tự chế thêm trường/giá trị trùng tên thật.
4. Thư mục này **không bao giờ** được đồng bộ với dữ liệu production. Khi deploy thật, dùng script seed riêng (`server/src/scripts/seed-sql-cli.js` / `npm run seed`) hoặc nhập tay bởi người có thẩm quyền (AGENT_RULES.md mục 1.3).

## Danh sách file

| File | Mô tả | Bảng SQL Server tương ứng (`server/sql/schema.sql`) |
|---|---|---|
| `users.mock.json` | Tài khoản mẫu (`admin`, `examiner`, `leader`, `candidate`) kèm `must_change_password` | `users` |
| `roles.mock.json` | 4 vai trò của hệ thống (`admin`, `examiner`, `leader`, `candidate`) | `roles` |
| `employees.mock.json` | Hồ sơ nhân viên tương ứng, hỗ trợ nhân viên kiêm nhiệm | `employees`, `employee_extra_departments` |
| `departments.mock.json` | Danh sách phòng ban chuyên môn mẫu kèm `slug` và mã `code` chuẩn hóa | `departments` |
| `topics.mock.json` | Danh sách chủ đề thi trắc nghiệm mẫu | `topics` |
| `questions.mock.json` | Ngân hàng câu hỏi mẫu (phân định `usage`: `'exam'` vs `'practice'`, độ khó, phạm vi) | `questions` |
| `answers.mock.json` | Đáp án của các câu hỏi mẫu tương ứng | `answers` |
| `studyDocuments.mock.json` | Tài liệu học tập/ôn tập mẫu (PDF/Word), phân quyền theo phạm vi phòng ban | `study_documents` |
| `exams.mock.json` | Đề xuất kỳ thi mẫu (`allow_common_compensation`, `department_scope`, `row_version`) | `exams`, `exam_allowed_departments` |
| `examCodes.mock.json` | Mã đề thi đã sinh (kèm `code`, `department_id`, `question_set_fingerprint`) | `exam_codes`, `exam_code_questions` |
| `examCandidates.mock.json` | Danh sách thí sinh được phân mã đề, hỗ trợ xác nhận vai trò (`role_chosen_by`, `role_confirmed_at`) | `exam_candidates` |
| `examAttempts.mock.json` | Các lượt thi mẫu của thí sinh (`department_id`, `leave_count`, `auto_submit_reason`) | `exam_attempts`, `attempt_questions`, `attempt_question_answers`, `candidate_answers`, `candidate_answer_selections` |
| `results.mock.json` | Kết quả thi mẫu, chấm điểm tự động gắn với lượt thi | `results` |
| `practiceSessions.mock.json` | Phiên luyện tập tự do của thí sinh (chế độ `'instant'` / `'exam'`, lưu snapshot câu hỏi/đáp án) | `practice_sessions`, `practice_session_topics`, `practice_questions`, `practice_question_options`, `practice_question_correct_answers`, `practice_question_selected_answers` |
| `notifications.mock.json` | Thông báo in-app theo thời gian thực (đề xuất, phê duyệt, phát hành kỳ thi) | `notifications` |
| `aiSetting.mock.json` | Cấu hình tham số Trợ lý AI (`base_url`, `model`, `system_prompt`, `max_doc_chars`) | `ai_settings` |
| `auditLog.mock.json` | Nhật ký hệ thống mẫu ghi lại các hành động nhạy cảm của người dùng | `audit_logs` |

## Lưu ý kỹ thuật

- Hệ thống hiện tại sử dụng **Microsoft SQL Server** (`server/sql/schema.sql`, 30 bảng quan hệ). Khóa chính trong CSDL là kiểu **`UNIQUEIDENTIFIER` (UUID)** và tên cột dùng **`snake_case`**; tầng service (`mapRow` trong `server/src/db/sql-helpers.js`) tự động ánh xạ sang **`camelCase`** và gắn thêm `_id` dạng chuỗi khi trả về API/JS.
- Các file `.mock.json` hiện tại vẫn đang giữ định dạng ID chuỗi 24 ký tự (từ phiên bản MongoDB cũ) để tham khảo cấu trúc dữ liệu mức ứng dụng. Khi viết truy vấn SQL trực tiếp, cần dùng khóa ngoại chuẩn hóa theo `schema.sql` và `JOIN` qua các bảng liên kết (junction tables).
- Mật khẩu mẫu trong `users.mock.json` là hash bcrypt **giả** (chuỗi placeholder), không dùng để test `bcrypt.compare` thật.
- Câu hỏi mẫu cố tình có nội dung vô thưởng vô phạt (kiến thức phổ thông, nội quy an toàn lao động cơ bản) — không liên quan chuyên môn quân sự/nội bộ thật.
- Khóa API trong `aiSetting.mock.json` là chuỗi placeholder vô hiệu (`AIzaSyDemoFakeApiKeyPlaceholder12345`), tuân thủ triệt để `AGENT_RULES.md`.
