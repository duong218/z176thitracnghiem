import { Router } from 'express';
import multer from 'multer';
import os from 'os';
import path from 'path';
import { authenticate, requireRoleCodes } from '../middlewares/auth.middleware.js';
import { requirePasswordChanged } from '../middlewares/require-password-changed.middleware.js';
import { env } from '../config/env.js';
import { ApiError } from '../utils/api-error.js';
import { createBackup, getBackupStatus, listBackups, downloadBackup, restoreBackup } from '../controllers/backup.controller.js';

const router = Router();

// Upload file backup (.bak hoặc .bak.enc) vào thư mục tạm OS trước khi RESTORE DATABASE đọc
const uploadBackupFile = multer({
  dest: env.backupSqlDir ? path.join(path.resolve(env.backupSqlDir), 'uploads') : path.join(os.tmpdir(), 'z176-backup-uploads'),
  limits: { fileSize: 2 * 1024 * 1024 * 1024 }, // 2GB, chỉnh theo dung lượng DB thực tế
  fileFilter: (req, file, cb) => {
    if (!/\.bak(\.enc)?$/i.test(file.originalname)) {
      return cb(new Error('Chỉ chấp nhận file .bak hoặc .bak.enc (được tạo từ chức năng backup).'));
    }
    cb(null, true);
  },
});

// Lỗi upload (file quá lớn, sai đuôi) trả ApiError để web hiện đúng lý do thay vì "Lỗi máy chủ"
const receiveBackupFile = (req, res, next) =>
  uploadBackupFile.single('backupFile')(req, res, (err) => {
    if (!err) return next();
    const tooBig = err.code === 'LIMIT_FILE_SIZE';
    next(new ApiError(tooBig ? 413 : 400, tooBig ? 'File backup quá lớn (tối đa 2GB).' : err.message, 'BACKUP_UPLOAD_FAILED'));
  });

router.use(authenticate, requirePasswordChanged, requireRoleCodes('admin'));

router.get('/', listBackups);
router.post('/', createBackup);
router.get('/status', getBackupStatus);
router.get('/:fileId/download', downloadBackup);
router.post('/restore', receiveBackupFile, restoreBackup);

export default router;