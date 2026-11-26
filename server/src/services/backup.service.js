/**
 * Service Sao lưu & Khôi phục CSDL SQL Server và Tích hợp Google Drive (Backup Service).
 * Dùng BACKUP DATABASE / RESTORE DATABASE (file .bak), mã hóa AES-256-GCM rồi đồng bộ lên Google Drive qua OAuth2.
 */

import crypto from 'crypto';
import { pipeline } from 'stream/promises';
import path from 'path';
import os from 'os';
import fs from 'fs/promises';
import fssync from 'fs';
import { google } from 'googleapis';
import { env } from '../config/env.js';
import { ApiError } from '../utils/api-error.js';
import { sql, sqlPool, closeSqlPool, openAdminPool, setDbMaintenance } from '../db/sql-server.js';

const MAX_BACKUPS_KEPT = 5;
const TMP_DIR = env.backupSqlDir ? path.resolve(env.backupSqlDir) : path.join(os.tmpdir(), 'z176-backups');

// Biến lỗi thô (mssql / Google / fs) thành ApiError có tên bước + lỗi gốc + gợi ý, để web hiện đúng nguyên nhân.
function explain(err, label) {
  if (err instanceof ApiError) return err;
  // mssql: nguyên nhân thật (vd lỗi 3201 "Operating system error 5") nằm trong precedingErrors, err.message chỉ là câu tổng kết
  const raw = [...(err?.precedingErrors ?? []).map((e) => e.message), err?.message ?? String(err)].join(' ');
  let hint = '';
  if (/Operating system error 5|Access is denied|EACCES|EPERM/i.test(raw)) {
    hint = ` Gợi ý: tài khoản dịch vụ SQL Server hoặc Node chưa có quyền với thư mục "${TMP_DIR}". Tạo thư mục riêng, cấp quyền Modify cho tài khoản dịch vụ SQL rồi đặt BACKUP_SQL_DIR trong .env.`;
  } else if (/Operating system error 3|cannot open backup device|ENOENT/i.test(raw)) {
    hint = ` Gợi ý: không thấy file/thư mục "${TMP_DIR}" (SQL Server và Node phải thấy cùng đường dẫn này).`;
  } else if (/Exclusive access could not be obtained/i.test(raw)) {
    hint = ' Gợi ý: còn kết nối khác đang dùng database, hãy thử lại sau ít giây.';
  } else if (/invalid_grant/i.test(raw)) {
    hint = ' Gợi ý: GOOGLE_REFRESH_TOKEN đã hết hạn hoặc bị thu hồi, chạy "node src/scripts/get-google-refresh-token.js" để lấy mã mới.';
  }
  console.error(`[backup] ${label} thất bại:`, err);
  const dot = /[.!?]$/.test(raw) ? '' : '.';
  return new ApiError(500, `${label} thất bại: ${raw}${dot}${hint}`, 'BACKUP_STEP_FAILED');
}

async function step(label, fn) {
  try {
    return await fn();
  } catch (err) {
    throw explain(err, label);
  }
}

// Đảm bảo thư mục lưu file .bak tạm tồn tại trên server
async function ensureTmpDir() {
  await fs.mkdir(TMP_DIR, { recursive: true, mode: 0o700 }); // chỉ tiến trình server đọc được bản dump chưa mã hóa
}

// Kiểm tra đầy đủ thông tin xác thực Google OAuth2 trong biến môi trường
function assertGoogleConfigured() {
  const { clientId, clientSecret, refreshToken, folderId } = env.googleBackup;
  if (!clientId || !clientSecret || !refreshToken || !folderId) {
    throw new ApiError(
      500,
      'Chưa cấu hình Google Drive backup (GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET / GOOGLE_REFRESH_TOKEN / GOOGLE_DRIVE_BACKUP_FOLDER_ID).',
      'GOOGLE_BACKUP_NOT_CONFIGURED'
    );
  }
}

// Khởi tạo Google Drive API Client bằng OAuth2 Refresh Token (cho phép ghi vào Drive cá nhân)
function getDriveClient() {
  assertGoogleConfigured();
  const { clientId, clientSecret, refreshToken } = env.googleBackup;

  const oAuth2Client = new google.auth.OAuth2(clientId, clientSecret);
  oAuth2Client.setCredentials({ refresh_token: refreshToken });

  return google.drive({ version: 'v3', auth: oAuth2Client });
}

// Xóa file tạm cục bộ sau khi hoàn thành thao tác
async function cleanupLocalFile(filePath) {
  try {
    if (filePath && fssync.existsSync(filePath)) {
      await fs.unlink(filePath);
    }
  } catch {
    /* best-effort cleanup */
  }
}

// --- Mã hóa bản backup trước khi lên Google Drive: AES-256-GCM (stream, không nạp cả file vào RAM) ---
// Định dạng: MAGIC(8) | salt(16) | iv(12) | ciphertext | authTag(16). Khóa = scrypt(BACKUP_ENCRYPTION_KEY, salt).
// MẤT BACKUP_ENCRYPTION_KEY = MẤT TOÀN BỘ bản backup đã mã hóa, hãy cất khóa ở nơi riêng (không chỉ trong .env).
const MAGIC = Buffer.from('Z176ENC1');
const SALT_LEN = 16;
const IV_LEN = 12;
const TAG_LEN = 16;
const HEADER_LEN = MAGIC.length + SALT_LEN + IV_LEN;

function deriveKey(salt) {
  if (!env.backupEncryptionKey) {
    throw new ApiError(500, 'Thiếu BACKUP_ENCRYPTION_KEY để mã hóa/giải mã bản sao lưu.', 'BACKUP_KEY_MISSING');
  }
  return crypto.scryptSync(env.backupEncryptionKey, salt, 32);
}

async function encryptFile(src, dest, onBytes) {
  const salt = crypto.randomBytes(SALT_LEN);
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv('aes-256-gcm', deriveKey(salt), iv);
  await fs.writeFile(dest, Buffer.concat([MAGIC, salt, iv]), { mode: 0o600 });
  const input = fssync.createReadStream(src);
  if (onBytes) {
    let done = 0;
    input.on('data', (chunk) => onBytes((done += chunk.length)));
  }
  await pipeline(input, cipher, fssync.createWriteStream(dest, { flags: 'a' }));
  await fs.appendFile(dest, cipher.getAuthTag());
}

// File có đúng là bản backup đã mã hóa (đọc 8 byte đầu)? Bản .bak chưa mã hóa (dev) vẫn khôi phục được.
async function isEncrypted(filePath) {
  const fh = await fs.open(filePath, 'r');
  try {
    const head = Buffer.alloc(MAGIC.length);
    await fh.read(head, 0, MAGIC.length, 0);
    return head.equals(MAGIC);
  } finally {
    await fh.close();
  }
}

async function decryptFile(src, dest) {
  const { size } = await fs.stat(src);
  if (size < HEADER_LEN + TAG_LEN) {
    throw new ApiError(400, 'File sao lưu mã hóa bị hỏng hoặc không đầy đủ.', 'BACKUP_FILE_CORRUPT');
  }
  const fh = await fs.open(src, 'r');
  const head = Buffer.alloc(HEADER_LEN);
  const tag = Buffer.alloc(TAG_LEN);
  try {
    await fh.read(head, 0, HEADER_LEN, 0);
    await fh.read(tag, 0, TAG_LEN, size - TAG_LEN);
  } finally {
    await fh.close();
  }
  const salt = head.subarray(MAGIC.length, MAGIC.length + SALT_LEN);
  const iv = head.subarray(MAGIC.length + SALT_LEN);
  const decipher = crypto.createDecipheriv('aes-256-gcm', deriveKey(salt), iv);
  decipher.setAuthTag(tag);
  try {
    await pipeline(
      fssync.createReadStream(src, { start: HEADER_LEN, end: size - TAG_LEN - 1 }),
      decipher,
      fssync.createWriteStream(dest, { mode: 0o600 })
    );
  } catch {
    // GCM báo lỗi xác thực khi sai khóa hoặc file bị sửa; chưa động tới CSDL nên báo lỗi an toàn.
    throw new ApiError(400, 'Không giải mã được: sai BACKUP_ENCRYPTION_KEY hoặc file đã bị sửa/hỏng.', 'BACKUP_DECRYPT_FAILED');
  }
}

// Xuất CSDL SQL Server ra file .bak trong thư mục tạm
async function dumpToLocalFile(prefix = 'z176-backup') {
  await ensureTmpDir();
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const fileName = `${prefix}-${timestamp}.bak`;
  const filePath = path.join(TMP_DIR, fileName);

  const dbName = env.sqlServer.database.replace(/]/g, ']]');
  const pool = await sqlPool();
  await pool.request().input('bakPath', sql.NVarChar(1000), filePath).query(
    `BACKUP DATABASE [${dbName}] TO DISK = @bakPath WITH FORMAT, INIT, NAME = N'Z176 Full Backup'`
  );

  const stat = await fs.stat(filePath);
  return { filePath, fileName, size: stat.size };
}

// Tải file backup (.bak hoặc .bak.enc) lên thư mục sao lưu trên Google Drive
async function uploadToDrive(filePath, fileName, onBytes) {
  const drive = getDriveClient();
  const res = await drive.files.create(
    {
      requestBody: {
        name: fileName,
        parents: [env.googleBackup.folderId],
      },
      media: {
        mimeType: 'application/octet-stream',
        body: fssync.createReadStream(filePath),
      },
      fields: 'id, name, size, createdTime',
    },
    onBytes ? { onUploadProgress: (evt) => onBytes(evt.bytesRead) } : undefined
  );
  return res.data;
}

// Quy trình sao lưu trọn gói: Dump DB -> Mã hóa -> Upload Drive -> Dọn file tạm
// onProgress(phase, percent) tùy chọn: dump 0% (BACKUP DATABASE không báo tiến độ nên không có % thật) -> mã hóa 30-50% -> upload tới 100%.
// Không bật mã hóa (dev) thì upload chiếm 30-100%.
async function createBackupToDrive({ prefix = 'z176-backup', onProgress } = {}) {
  const encrypt = Boolean(env.backupEncryptionKey);
  // Production: thà báo lỗi rõ còn hơn lặng lẽ đẩy dữ liệu nhân sự chưa mã hóa lên Drive ngoài.
  if (!encrypt && env.isProduction) {
    throw new ApiError(
      500,
      'Chưa cấu hình BACKUP_ENCRYPTION_KEY: không sao lưu bản chưa mã hóa lên Google Drive.',
      'BACKUP_KEY_MISSING'
    );
  }
  if (!encrypt) console.warn('[backup] BACKUP_ENCRYPTION_KEY chưa đặt: bản sao lưu lên Drive KHÔNG được mã hóa (chỉ cho dev).');

  const report = (phase, from, span, done, total) =>
    onProgress?.(phase, Math.min(100, Math.round(from + (span * done) / Math.max(total, 1))));

  onProgress?.('dump', 0);
  const { filePath, fileName, size } = await step('Tạo file .bak (BACKUP DATABASE)', () => dumpToLocalFile(prefix));
  const encPath = `${filePath}.enc`;
  try {
    if (encrypt) await step('Mã hóa bản sao lưu', () => encryptFile(filePath, encPath, (done) => report('encrypt', 30, 20, done, size)));
    const upFrom = encrypt ? 50 : 30;
    const upPath = encrypt ? encPath : filePath;
    const { size: upSize } = await fs.stat(upPath);
    return await step('Tải lên Google Drive', () =>
      uploadToDrive(upPath, encrypt ? `${fileName}.enc` : fileName, (sent) => report('upload', upFrom, 100 - upFrom, sent, upSize))
    );
  } finally {
    await cleanupLocalFile(filePath);
    await cleanupLocalFile(encPath);
  }
}

// --- Backup thủ công chạy NỀN: POST trả về ngay, client hỏi tiến độ qua getBackupJob() ---
// Chỉ 1 job cùng lúc. Trạng thái giữ trong RAM của tiến trình server: restart server giữa chừng thì job mất.
// ponytail: job trong RAM (1 instance server); chạy nhiều instance thì đưa trạng thái vào DB/Redis.
let job = { state: 'idle' };

function getBackupJob() {
  return { ...job };
}

// Đang chạy thì bỏ qua (idempotent): client chỉ cần theo dõi job hiện tại.
function startBackupJob({ prefix = 'z176-manual', afterSuccess } = {}) {
  if (job.state === 'running') return;
  job = { state: 'running', phase: 'dump', percent: 0, startedAt: Date.now() };
  const mine = job;
  (async () => {
    try {
      const file = await createBackupToDrive({
        prefix,
        onProgress: (phase, percent) => Object.assign(mine, { phase, percent }),
      });
      mine.phase = 'rotate';
      const { kept, deleted } = await step('Xoay vòng bản cũ trên Google Drive', () => rotateDriveBackups());
      try {
        await afterSuccess?.(file, { kept, deleted });
      } catch (err) {
        console.error('[backup] afterSuccess lỗi (bản sao lưu đã tạo xong):', err.message);
      }
      Object.assign(mine, {
        state: 'done',
        percent: 100,
        finishedAt: Date.now(),
        message: 'Tạo bản sao lưu thành công.',
        result: { id: file.id, name: file.name, size: Number(file.size ?? 0), createdTime: file.createdTime },
      });
    } catch (err) {
      console.error('[backup] Backup thủ công thất bại:', err.message);
      Object.assign(mine, {
        state: 'error',
        finishedAt: Date.now(),
        message: err instanceof ApiError ? err.message : 'Backup thất bại. Vui lòng thử lại hoặc kiểm tra nhật ký máy chủ.',
      });
    }
  })();
}

// Lấy danh sách các file backup đang lưu trên Google Drive (mới nhất xếp trước)
async function listDriveBackups() {
  const drive = getDriveClient();
  const res = await step('Đọc danh sách bản sao lưu trên Google Drive', () =>
    drive.files.list({
      q: `'${env.googleBackup.folderId}' in parents and trashed = false`,
      fields: 'files(id, name, size, createdTime)',
      orderBy: 'createdTime desc',
      pageSize: 100,
    })
  );
  return res.data.files ?? [];
}

// Xoay vòng bản sao lưu: Giữ tối đa N bản mới nhất, tự động xóa các bản cũ hơn trên Google Drive
async function rotateDriveBackups(maxKept = MAX_BACKUPS_KEPT) {
  const drive = getDriveClient();
  const files = await listDriveBackups();
  const toDelete = files.slice(maxKept);

  for (const file of toDelete) {
    await drive.files.delete({ fileId: file.id });
  }
  return { kept: files.length - toDelete.length, deleted: toDelete.map((f) => f.name) };
}

// Tải file từ Drive về thư mục tạm cục bộ
async function downloadDriveFileToLocal(fileId, fileName) {
  await ensureTmpDir();
  const drive = getDriveClient();
  const filePath = path.join(TMP_DIR, `download-${Date.now()}-${fileName}`);

  const res = await drive.files.get({ fileId, alt: 'media' }, { responseType: 'stream' });

  await new Promise((resolve, reject) => {
    const dest = fssync.createWriteStream(filePath);
    res.data.pipe(dest).on('finish', resolve).on('error', reject);
  });

  return filePath;
}

// Stream trực tiếp dữ liệu file từ Google Drive ra HTTP response cho client tải về
async function streamDriveFileToResponse(fileId, res) {
  const drive = getDriveClient();
  const driveRes = await step('Tải bản sao lưu từ Google Drive', () =>
    drive.files.get({ fileId, alt: 'media' }, { responseType: 'stream' })
  );
  driveRes.data.pipe(res);
}

// Khôi phục dữ liệu CSDL SQL Server từ file .bak / .bak.enc
// Giải mã xong mới chạy RESTORE DATABASE: sai khóa thì dừng trước khi ghi đè, CSDL còn nguyên.
async function restoreFromLocalFile(localFilePath) {
  const decPath = `${localFilePath}.dec`;
  let masterPool;
  try {
    let archive = localFilePath;
    if (await isEncrypted(localFilePath)) {
      await decryptFile(localFilePath, decPath);
      archive = decPath;
    }

    const dbName = env.sqlServer.database.replace(/]/g, ']]');
    setDbMaintenance(true); // /auth/me, cron... trả 503 thay vì mở lại kết nối chiếm SINGLE_USER
    await closeSqlPool();
    masterPool = await step('Kết nối SQL Server (database master)', () => openAdminPool());

    await step('Chuyển database sang chế độ một người dùng', () =>
      masterPool.request().query(`ALTER DATABASE [${dbName}] SET SINGLE_USER WITH ROLLBACK IMMEDIATE`)
    );
    try {
      await step('RESTORE DATABASE', () =>
        masterPool.request().input('bakPath', sql.NVarChar(1000), archive).query(
          `RESTORE DATABASE [${dbName}] FROM DISK = @bakPath WITH REPLACE`
        )
      );
    } finally {
      await masterPool.request().query(`ALTER DATABASE [${dbName}] SET MULTI_USER`).catch(() => {});
    }
  } finally {
    if (masterPool) await masterPool.close().catch(() => {});
    setDbMaintenance(false);
    await sqlPool().catch(() => {});
    await cleanupLocalFile(decPath);
  }
}

export const backupService = {
  createBackupToDrive,
  startBackupJob,
  getBackupJob,
  listDriveBackups,
  rotateDriveBackups,
  downloadDriveFileToLocal,
  streamDriveFileToResponse,
  restoreFromLocalFile,
  cleanupLocalFile,
  encryptFile,
  decryptFile,
  isEncrypted,
  MAX_BACKUPS_KEPT,
};