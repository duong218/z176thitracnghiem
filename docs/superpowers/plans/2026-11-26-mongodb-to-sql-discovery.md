# MongoDB to SQL Migration Discovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace MongoDB/Mongoose with one relational SQL database while preserving the existing API contracts and examination behaviour.

**Architecture:** Use a staged migration to a new Microsoft SQL Server database, keeping the React client and Express routes unchanged. Model document references and embedded arrays as foreign keys and join tables; move reporting aggregations to SQL queries. Do not import MongoDB data: initialise the empty database with the existing seed data after the SQL service layer is ready.

**Tech Stack:** Node.js 22, Express 4, Microsoft SQL Server, selected SQL Server client/ORM, SQL Server-native backup utility.

**Spec:** User request dated 2026-11-26; target engine is Microsoft SQL Server; start with an empty database and run seed data rather than importing MongoDB data.

## Global Constraints

- Do not access, copy, or migrate real internal data through this workspace; use mock data only.
- Preserve existing authentication, exam grading, answer randomisation, audit trails, and API response contracts.
- Do not change core data schemas or backup/restore production configuration until the project owner approves the design.
- Replace Mongo-specific backup, import, cleanup, and load-test scripts as part of the migration.
- Keep the client independent of the database conversion.

## Review Focus

- Concurrent exam submission must create exactly one attempt/result and retain all selected answers.
- Foreign-key delete/update rules must not erase exam history, audit records, or study documents unexpectedly.
- Multi-valued Mongo fields (`extraDepartmentIds`, allowed departments, answer ordering, practice snapshots) must retain ordering and semantics.
- Report and analytics filters must return the same totals, pagination, and access-scoped results.
- Backup/restore must be encrypted, testable against a non-production database, and never expose credentials in process arguments.

---

## File Structure

- Create: `server/sql/schema.sql` — approved relational schema, constraints, indexes, and join tables.
- Create: `server/src/db/*` — selected SQL client, repositories, transactions, and migration runner.
- Modify: `server/src/config/env.js`, `server/src/config/db.js`, `env.example` — SQL connection configuration.
- Modify: `server/src/services/*.js`, `server/src/middlewares/auth.middleware.js` — replace Mongoose queries with SQL repositories.
- Modify: `server/src/services/backup.service.js`, `server/src/scripts/*.js`, `server/loadtest/*.js` — SQL-native operations.
- Create: `server/src/scripts/init-sql-database.js` — creates the configured empty SQL Server database and applies the schema.
- Modify: `server/package.json`, `README.md`, and affected `docs/*` — dependencies and operations documentation.

### Task 1: Approve the target database and rollout

**Files:**
- Modify: this plan

**Interfaces:**
- Consumes: database engine, hosting constraints, existing-data migration requirement, allowed maintenance window.
- Produces: selected SQL dialect, driver/ORM, identifier strategy, and cutover approach.

- [x] **Step 1: Select Microsoft SQL Server**

Record the SQL Server version and deployment environment before implementation.

- [x] **Step 2: Select the cutover approach**

Create a clean SQL Server database and initialise it using seed/mock data. Do not import or dual-write MongoDB data.

- [ ] **Step 3: Approve the relational schema before implementation**

Confirm primary-key format, foreign-key delete rules, JSON columns, and join tables for every current model.

### Task 2: Design and validate the relational schema

**Files:**
- Create: `server/sql/schema.sql`
- Test: `server/test/sql-schema.test.mjs`

**Interfaces:**
- Consumes: Task 1 dialect and identifier decision.
- Produces: tables for all current models, ordered join tables, indexes, constraints, and a repeatable empty-database setup.

- [ ] **Step 1: Write schema tests for unique credentials, required relationships, ordered answer snapshots, and protected exam history**

- [ ] **Step 2: Run schema tests against an empty disposable SQL database**

Expected: FAIL until the schema exists.

- [ ] **Step 3: Implement `server/sql/schema.sql`**

Map every Mongoose model and embedded/reference array explicitly; use foreign keys and join tables rather than comma-separated identifiers.

- [ ] **Step 4: Run schema tests and seed data**

Expected: PASS with all constraints applied.

### Task 3: Replace database access by bounded domains

**Files:**
- Create: `server/src/db/*`
- Modify: `server/src/models/index.js`, `server/src/config/db.js`, `server/src/services/*.js`, `server/src/middlewares/auth.middleware.js`
- Test: `server/test/*.mjs`

**Interfaces:**
- Consumes: SQL schema from Task 2.
- Produces: SQL-backed service behaviour with existing controller and route interfaces unchanged.

- [ ] **Step 1: Write contract tests for auth/users, question bank, exam generation/attempts, practice, documents/notifications, reports, and analytics**

- [ ] **Step 2: Convert each domain in dependency order: roles/users/departments/employees; topics/questions/answers; exams/attempts/results; then documents, notifications, analytics, and reports**

- [ ] **Step 3: Wrap multi-record writes in transactions**

Cover user creation, import commits, exam assignment, attempt start/submission, and account purge.

- [ ] **Step 4: Run the full server test suite and exercise existing API smoke paths**

Expected: all tests pass without Mongoose imports.

### Task 4: Replace operations and complete the cutover

**Files:**
- Modify: `server/src/services/backup.service.js`, `server/src/scripts/*.js`, `server/loadtest/*.js`, `server/package.json`, `env.example`, `README.md`, `docs/*`
- Create: `server/src/scripts/init-sql-database.js`
- Test: `server/test/test_backup_crypto.mjs`, `server/test/sql-init.test.mjs`

**Interfaces:**
- Consumes: SQL connection and migrated service layer.
- Produces: SQL-native backup/restore, an idempotent empty-database initialisation path, and updated deployment instructions.

- [ ] **Step 1: Write failing tests for backup encryption and repeatable empty-database initialisation**

- [ ] **Step 2: Replace `mongodump`/`mongorestore` with the approved engine's backup and restore mechanism**

- [ ] **Step 3: Implement `init-sql-database.js` and run the existing seed command against the new SQL database**

- [ ] **Step 4: Remove MongoDB dependencies/configuration only after SQL staging verification and seed data checks succeed**

- [ ] **Step 5: Run backup/restore rehearsal and all tests against a disposable SQL database**

Expected: restore passes integrity checks and the application starts with no MongoDB configuration.
