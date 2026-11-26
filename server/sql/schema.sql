/* SQL Server relational schema for the Z176 examination system. */
SET ANSI_NULLS ON;
SET QUOTED_IDENTIFIER ON;

IF OBJECT_ID('roles', 'U') IS NULL CREATE TABLE roles (
  id UNIQUEIDENTIFIER NOT NULL DEFAULT NEWSEQUENTIALID() PRIMARY KEY,
  code NVARCHAR(32) NOT NULL UNIQUE, name NVARCHAR(255) NOT NULL,
  description NVARCHAR(MAX) NULL, is_active BIT NOT NULL DEFAULT 1,
  created_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(), updated_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME()
);
IF OBJECT_ID('departments', 'U') IS NULL CREATE TABLE departments (
  id UNIQUEIDENTIFIER NOT NULL DEFAULT NEWSEQUENTIALID() PRIMARY KEY,
  name NVARCHAR(255) NOT NULL UNIQUE, slug NVARCHAR(255) NULL UNIQUE, code NVARCHAR(64) NULL UNIQUE,
  description NVARCHAR(MAX) NOT NULL DEFAULT '', is_active BIT NOT NULL DEFAULT 1,
  created_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(), updated_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME()
);
IF OBJECT_ID('users', 'U') IS NULL CREATE TABLE users (
  id UNIQUEIDENTIFIER NOT NULL DEFAULT NEWSEQUENTIALID() PRIMARY KEY,
  username NVARCHAR(255) NOT NULL UNIQUE, password_hash NVARCHAR(255) NOT NULL,
  role_id UNIQUEIDENTIFIER NOT NULL REFERENCES roles(id), must_change_password BIT NOT NULL DEFAULT 0,
  is_active BIT NOT NULL DEFAULT 1, failed_login_attempts INT NOT NULL DEFAULT 0,
  lock_until DATETIME2 NULL, locked_at DATETIME2 NULL, token_version INT NOT NULL DEFAULT 0,
  created_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(), updated_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME()
);
IF OBJECT_ID('employees', 'U') IS NULL CREATE TABLE employees (
  id UNIQUEIDENTIFIER NOT NULL DEFAULT NEWSEQUENTIALID() PRIMARY KEY,
  user_id UNIQUEIDENTIFIER NOT NULL UNIQUE REFERENCES users(id), department_id UNIQUEIDENTIFIER NOT NULL REFERENCES departments(id),
  fullname NVARCHAR(255) NOT NULL, employee_code NVARCHAR(128) NULL UNIQUE,
  dob NVARCHAR(64) NOT NULL DEFAULT '', gender NVARCHAR(64) NOT NULL DEFAULT '', phone NVARCHAR(64) NOT NULL DEFAULT '',
  address NVARCHAR(MAX) NOT NULL DEFAULT '', position NVARCHAR(255) NOT NULL DEFAULT '', is_active BIT NOT NULL DEFAULT 1,
  created_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(), updated_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME()
);
IF OBJECT_ID('employee_extra_departments', 'U') IS NULL CREATE TABLE employee_extra_departments (
  employee_id UNIQUEIDENTIFIER NOT NULL REFERENCES employees(id), department_id UNIQUEIDENTIFIER NOT NULL REFERENCES departments(id),
  PRIMARY KEY (employee_id, department_id)
);
IF OBJECT_ID('topics', 'U') IS NULL CREATE TABLE topics (
  id UNIQUEIDENTIFIER NOT NULL DEFAULT NEWSEQUENTIALID() PRIMARY KEY, name NVARCHAR(255) NOT NULL UNIQUE,
  description NVARCHAR(MAX) NULL, is_active BIT NOT NULL DEFAULT 1,
  created_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(), updated_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME()
);
IF OBJECT_ID('questions', 'U') IS NULL CREATE TABLE questions (
  id UNIQUEIDENTIFIER NOT NULL DEFAULT NEWSEQUENTIALID() PRIMARY KEY, content NVARCHAR(MAX) NOT NULL,
  question_kind NVARCHAR(32) NOT NULL CHECK (question_kind IN ('theory','practice')),
  answer_type NVARCHAR(32) NOT NULL CHECK (answer_type IN ('single','multiple')),
  difficulty NVARCHAR(32) NOT NULL CHECK (difficulty IN ('easy','medium','hard')),
  scope NVARCHAR(32) NOT NULL CHECK (scope IN ('Common','DepartmentSpecific')),
  topic_id UNIQUEIDENTIFIER NOT NULL REFERENCES topics(id), department_id UNIQUEIDENTIFIER NULL REFERENCES departments(id),
  image_url NVARCHAR(MAX) NULL, image_cloudinary_id NVARCHAR(255) NULL,
  usage NVARCHAR(32) NOT NULL DEFAULT 'exam' CHECK (usage IN ('exam','practice')),
  is_active BIT NOT NULL DEFAULT 1, created_by UNIQUEIDENTIFIER NULL REFERENCES users(id),
  created_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(), updated_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
  CONSTRAINT CK_questions_scope_department CHECK ((scope = 'Common' AND department_id IS NULL) OR (scope = 'DepartmentSpecific' AND department_id IS NOT NULL))
);
CREATE INDEX IX_questions_lookup ON questions(topic_id, scope, department_id, is_active);
IF OBJECT_ID('answers', 'U') IS NULL CREATE TABLE answers (
  id UNIQUEIDENTIFIER NOT NULL DEFAULT NEWSEQUENTIALID() PRIMARY KEY, question_id UNIQUEIDENTIFIER NOT NULL REFERENCES questions(id),
  content NVARCHAR(MAX) NOT NULL, is_correct BIT NOT NULL DEFAULT 0, sort_order INT NOT NULL DEFAULT 0,
  created_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(), updated_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME()
);
CREATE INDEX IX_answers_question_order ON answers(question_id, sort_order);
IF OBJECT_ID('exams', 'U') IS NULL CREATE TABLE exams (
  id UNIQUEIDENTIFIER NOT NULL DEFAULT NEWSEQUENTIALID() PRIMARY KEY, title NVARCHAR(500) NOT NULL,
  topic_id UNIQUEIDENTIFIER NOT NULL REFERENCES topics(id), start_date DATETIME2 NULL, end_date DATETIME2 NULL,
  duration_minutes INT NOT NULL CHECK (duration_minutes > 0), total_questions INT NOT NULL CHECK (total_questions > 0),
  common_question_count INT NOT NULL CHECK (common_question_count >= 0), department_question_count INT NOT NULL CHECK (department_question_count >= 0),
  allow_common_compensation BIT NOT NULL DEFAULT 0, department_scope NVARCHAR(16) NOT NULL DEFAULT 'all' CHECK (department_scope IN ('all','selected')),
  status NVARCHAR(32) NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','pending_review','rejected','approved','published','archived')),
  pass_threshold_percent DECIMAL(5,2) NOT NULL DEFAULT 70 CHECK (pass_threshold_percent BETWEEN 0 AND 100),
  created_by UNIQUEIDENTIFIER NULL REFERENCES users(id), approved_by UNIQUEIDENTIFIER NULL REFERENCES users(id), approved_at DATETIME2 NULL,
  published_at DATETIME2 NULL, rejection_reason NVARCHAR(MAX) NULL, deleted_at DATETIME2 NULL, deleted_by_name NVARCHAR(255) NULL,
  publish_locked_at DATETIME2 NULL, row_version ROWVERSION NOT NULL,
  created_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(), updated_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
  CONSTRAINT CK_exam_counts CHECK (total_questions = common_question_count + department_question_count)
);
CREATE UNIQUE INDEX UX_exams_one_published ON exams(status) WHERE status = 'published';
IF OBJECT_ID('exam_allowed_departments', 'U') IS NULL CREATE TABLE exam_allowed_departments (
  exam_id UNIQUEIDENTIFIER NOT NULL REFERENCES exams(id), department_id UNIQUEIDENTIFIER NOT NULL REFERENCES departments(id), PRIMARY KEY(exam_id, department_id)
);
IF OBJECT_ID('exam_codes', 'U') IS NULL CREATE TABLE exam_codes (
  id UNIQUEIDENTIFIER NOT NULL DEFAULT NEWSEQUENTIALID() PRIMARY KEY, exam_id UNIQUEIDENTIFIER NOT NULL REFERENCES exams(id),
  code NVARCHAR(64) NOT NULL, department_id UNIQUEIDENTIFIER NOT NULL REFERENCES departments(id), question_set_fingerprint NVARCHAR(255) NULL,
  created_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(), updated_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(), UNIQUE(exam_id, code)
);
IF OBJECT_ID('exam_code_questions', 'U') IS NULL CREATE TABLE exam_code_questions (
  exam_code_id UNIQUEIDENTIFIER NOT NULL REFERENCES exam_codes(id), question_id UNIQUEIDENTIFIER NOT NULL REFERENCES questions(id), order_index INT NOT NULL CHECK(order_index >= 0),
  created_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(), updated_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
  PRIMARY KEY(exam_code_id, question_id), UNIQUE(exam_code_id, order_index)
);
IF OBJECT_ID('exam_candidates', 'U') IS NULL CREATE TABLE exam_candidates (
  id UNIQUEIDENTIFIER NOT NULL DEFAULT NEWSEQUENTIALID() PRIMARY KEY, exam_id UNIQUEIDENTIFIER NOT NULL REFERENCES exams(id),
  employee_id UNIQUEIDENTIFIER NOT NULL REFERENCES employees(id), exam_code_id UNIQUEIDENTIFIER NOT NULL REFERENCES exam_codes(id),
  extra_attempts_granted INT NOT NULL DEFAULT 0 CHECK(extra_attempts_granted >= 0), role_confirmed_at DATETIME2 NULL,
  role_chosen_by NVARCHAR(16) NULL CHECK(role_chosen_by IN ('candidate','leader','system')),
  created_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(), updated_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(), UNIQUE(exam_id, employee_id)
);
IF OBJECT_ID('exam_attempts', 'U') IS NULL CREATE TABLE exam_attempts (
  id UNIQUEIDENTIFIER NOT NULL DEFAULT NEWSEQUENTIALID() PRIMARY KEY, exam_candidate_id UNIQUEIDENTIFIER NOT NULL REFERENCES exam_candidates(id),
  attempt_type NVARCHAR(16) NOT NULL CHECK(attempt_type IN ('official','practice')), department_id UNIQUEIDENTIFIER NULL REFERENCES departments(id),
  started_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(), submitted_at DATETIME2 NULL,
  status NVARCHAR(16) NOT NULL DEFAULT 'in_progress' CHECK(status IN ('in_progress','submitted','expired')),
  exam_session_token_hash NVARCHAR(255) NULL, expires_at DATETIME2 NULL, last_active_at DATETIME2 NULL,
  auto_submit_reason NVARCHAR(32) NULL CHECK(auto_submit_reason IN ('inactive_timeout','exam_replaced','exam_ended')),
  leave_count INT NOT NULL DEFAULT 0 CHECK(leave_count >= 0), created_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(), updated_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME()
);
CREATE UNIQUE INDEX UX_attempt_one_active_official ON exam_attempts(exam_candidate_id) WHERE attempt_type = 'official' AND status = 'in_progress';
IF OBJECT_ID('attempt_questions', 'U') IS NULL CREATE TABLE attempt_questions (
  id UNIQUEIDENTIFIER NOT NULL DEFAULT NEWSEQUENTIALID() PRIMARY KEY, exam_attempt_id UNIQUEIDENTIFIER NOT NULL REFERENCES exam_attempts(id),
  question_id UNIQUEIDENTIFIER NOT NULL REFERENCES questions(id), order_index INT NOT NULL CHECK(order_index >= 0),
  created_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(), updated_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
  UNIQUE(exam_attempt_id, question_id), UNIQUE(exam_attempt_id, order_index)
);
IF OBJECT_ID('attempt_question_answers', 'U') IS NULL CREATE TABLE attempt_question_answers (
  attempt_question_id UNIQUEIDENTIFIER NOT NULL REFERENCES attempt_questions(id), answer_id UNIQUEIDENTIFIER NOT NULL REFERENCES answers(id), order_index INT NOT NULL CHECK(order_index >= 0),
  PRIMARY KEY(attempt_question_id, answer_id), UNIQUE(attempt_question_id, order_index)
);
IF OBJECT_ID('candidate_answers', 'U') IS NULL CREATE TABLE candidate_answers (
  id UNIQUEIDENTIFIER NOT NULL DEFAULT NEWSEQUENTIALID() PRIMARY KEY, exam_attempt_id UNIQUEIDENTIFIER NOT NULL REFERENCES exam_attempts(id),
  question_id UNIQUEIDENTIFIER NOT NULL REFERENCES questions(id), is_correct BIT NULL,
  created_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(), updated_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(), UNIQUE(exam_attempt_id, question_id)
);
IF OBJECT_ID('candidate_answer_selections', 'U') IS NULL CREATE TABLE candidate_answer_selections (
  candidate_answer_id UNIQUEIDENTIFIER NOT NULL REFERENCES candidate_answers(id), answer_id UNIQUEIDENTIFIER NOT NULL REFERENCES answers(id), PRIMARY KEY(candidate_answer_id, answer_id)
);
IF OBJECT_ID('results', 'U') IS NULL CREATE TABLE results (
  id UNIQUEIDENTIFIER NOT NULL DEFAULT NEWSEQUENTIALID() PRIMARY KEY, exam_attempt_id UNIQUEIDENTIFIER NOT NULL UNIQUE REFERENCES exam_attempts(id),
  score DECIMAL(5,2) NOT NULL CHECK(score BETWEEN 0 AND 100), correct_count INT NOT NULL CHECK(correct_count >= 0), total_questions INT NOT NULL CHECK(total_questions > 0), passed BIT NOT NULL,
  created_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(), updated_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME()
);
IF OBJECT_ID('practice_sessions', 'U') IS NULL CREATE TABLE practice_sessions (
  id UNIQUEIDENTIFIER NOT NULL DEFAULT NEWSEQUENTIALID() PRIMARY KEY, user_id UNIQUEIDENTIFIER NOT NULL REFERENCES users(id),
  difficulty NVARCHAR(32) NOT NULL DEFAULT 'all', mode NVARCHAR(16) NOT NULL DEFAULT 'exam' CHECK(mode IN ('instant','exam')),
  total_questions INT NOT NULL CHECK(total_questions > 0), correct_count INT NOT NULL DEFAULT 0 CHECK(correct_count >= 0), time_limit_sec INT NOT NULL DEFAULT 0 CHECK(time_limit_sec >= 0),
  status NVARCHAR(16) NOT NULL DEFAULT 'in_progress' CHECK(status IN ('in_progress','submitted','expired')),
  started_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(), submitted_at DATETIME2 NULL,
  created_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(), updated_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME()
);
CREATE INDEX IX_practice_sessions_user_status ON practice_sessions(user_id, status, submitted_at DESC);
IF OBJECT_ID('practice_session_topics', 'U') IS NULL CREATE TABLE practice_session_topics (
  practice_session_id UNIQUEIDENTIFIER NOT NULL REFERENCES practice_sessions(id), topic_id UNIQUEIDENTIFIER NOT NULL REFERENCES topics(id), PRIMARY KEY(practice_session_id, topic_id)
);
IF OBJECT_ID('practice_questions', 'U') IS NULL CREATE TABLE practice_questions (
  id UNIQUEIDENTIFIER NOT NULL DEFAULT NEWSEQUENTIALID() PRIMARY KEY, practice_session_id UNIQUEIDENTIFIER NOT NULL REFERENCES practice_sessions(id),
  question_id UNIQUEIDENTIFIER NOT NULL REFERENCES questions(id), is_correct BIT NOT NULL DEFAULT 0, checked BIT NOT NULL DEFAULT 0,
  order_index INT NOT NULL CHECK(order_index >= 0), UNIQUE(practice_session_id, question_id), UNIQUE(practice_session_id, order_index)
);
IF OBJECT_ID('practice_question_options', 'U') IS NULL CREATE TABLE practice_question_options (
  practice_question_id UNIQUEIDENTIFIER NOT NULL REFERENCES practice_questions(id), answer_id UNIQUEIDENTIFIER NOT NULL REFERENCES answers(id), order_index INT NOT NULL CHECK(order_index >= 0),
  PRIMARY KEY(practice_question_id, answer_id), UNIQUE(practice_question_id, order_index)
);
IF OBJECT_ID('practice_question_correct_answers', 'U') IS NULL CREATE TABLE practice_question_correct_answers (
  practice_question_id UNIQUEIDENTIFIER NOT NULL REFERENCES practice_questions(id), answer_id UNIQUEIDENTIFIER NOT NULL REFERENCES answers(id), PRIMARY KEY(practice_question_id, answer_id)
);
IF OBJECT_ID('practice_question_selected_answers', 'U') IS NULL CREATE TABLE practice_question_selected_answers (
  practice_question_id UNIQUEIDENTIFIER NOT NULL REFERENCES practice_questions(id), answer_id UNIQUEIDENTIFIER NOT NULL REFERENCES answers(id), PRIMARY KEY(practice_question_id, answer_id)
);
IF OBJECT_ID('study_documents', 'U') IS NULL CREATE TABLE study_documents (
  id UNIQUEIDENTIFIER NOT NULL DEFAULT NEWSEQUENTIALID() PRIMARY KEY, topic_id UNIQUEIDENTIFIER NOT NULL REFERENCES topics(id),
  title NVARCHAR(500) NOT NULL, file_path NVARCHAR(MAX) NOT NULL, original_file_name NVARCHAR(500) NULL, mime_type NVARCHAR(255) NULL,
  scope NVARCHAR(32) NOT NULL DEFAULT 'Common' CHECK(scope IN ('Common','DepartmentSpecific')),
  department_id UNIQUEIDENTIFIER NULL REFERENCES departments(id), uploaded_by UNIQUEIDENTIFIER NULL REFERENCES users(id), is_active BIT NOT NULL DEFAULT 1,
  created_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(), updated_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
  CONSTRAINT CK_documents_scope_department CHECK ((scope = 'Common') OR (scope = 'DepartmentSpecific' AND department_id IS NOT NULL))
);
IF OBJECT_ID('schedules', 'U') IS NULL CREATE TABLE schedules (
  id UNIQUEIDENTIFIER NOT NULL DEFAULT NEWSEQUENTIALID() PRIMARY KEY, exam_id UNIQUEIDENTIFIER NOT NULL REFERENCES exams(id), planned_date DATETIME2 NOT NULL,
  note NVARCHAR(MAX) NULL, created_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(), updated_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME()
);
IF OBJECT_ID('audit_logs', 'U') IS NULL CREATE TABLE audit_logs (
  id UNIQUEIDENTIFIER NOT NULL DEFAULT NEWSEQUENTIALID() PRIMARY KEY, actor_user_id UNIQUEIDENTIFIER NULL REFERENCES users(id), action NVARCHAR(255) NOT NULL,
  resource_type NVARCHAR(255) NOT NULL, resource_id UNIQUEIDENTIFIER NULL, metadata NVARCHAR(MAX) NULL, ip_address NVARCHAR(64) NULL,
  created_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(), CONSTRAINT CK_audit_metadata_json CHECK(metadata IS NULL OR ISJSON(metadata) = 1)
);
CREATE INDEX IX_audit_logs_created ON audit_logs(created_at DESC);
IF OBJECT_ID('notifications', 'U') IS NULL CREATE TABLE notifications (
  id UNIQUEIDENTIFIER NOT NULL DEFAULT NEWSEQUENTIALID() PRIMARY KEY, recipient_user_id UNIQUEIDENTIFIER NOT NULL REFERENCES users(id),
  type NVARCHAR(64) NOT NULL CHECK(type IN ('exam_submitted','exam_approved','exam_rejected','exam_published','exam_assignment_failed')),
  title NVARCHAR(500) NOT NULL, message NVARCHAR(MAX) NOT NULL, exam_id UNIQUEIDENTIFIER NULL REFERENCES exams(id), is_read BIT NOT NULL DEFAULT 0,
  created_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME()
);
CREATE INDEX IX_notifications_recipient_read_created ON notifications(recipient_user_id, is_read, created_at DESC);
IF OBJECT_ID('ai_settings', 'U') IS NULL CREATE TABLE ai_settings (
  id UNIQUEIDENTIFIER NOT NULL DEFAULT NEWSEQUENTIALID() PRIMARY KEY, [key] NVARCHAR(64) NOT NULL UNIQUE DEFAULT 'default', is_enabled BIT NOT NULL DEFAULT 0,
  base_url NVARCHAR(MAX) NOT NULL DEFAULT 'https://generativelanguage.googleapis.com/v1beta/openai', api_key NVARCHAR(MAX) NOT NULL DEFAULT '',
  model NVARCHAR(255) NOT NULL DEFAULT 'gemini-flash-latest', system_prompt NVARCHAR(MAX) NOT NULL DEFAULT '',
  max_doc_chars INT NOT NULL DEFAULT 60000 CHECK(max_doc_chars BETWEEN 5000 AND 400000), updated_by UNIQUEIDENTIFIER NULL REFERENCES users(id),
  created_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(), updated_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME()
);
