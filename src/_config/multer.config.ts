import { LogWrapper } from '@utils';
import * as fs from 'fs';
import * as multer from 'multer';
import * as path from 'path';

export const storage = multer.diskStorage({
  destination: async (req, file, cb) => {
    const logger = new LogWrapper('MulterStorage');

    try {
      const uploadRoot = 'uploads';

      if (!fs.existsSync(uploadRoot)) {
        fs.mkdirSync(uploadRoot, { recursive: true });
      }

      cb(null, uploadRoot);
    } catch (error) {
      await logger.error('Error in destination callback');
      cb(error, null);
    }
  },
  filename: async (req, file, cb) => {
    const logger = new LogWrapper('MulterStorage');

    try {
      const originalExtension = path.extname(file.originalname);
      const uniqueSuffix = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
      cb(null, `${file.fieldname}-${uniqueSuffix}${originalExtension}`);
    } catch (error) {
      await logger.error('Error in filename callback');
      cb(error, null);
    }
  },
});

export const csvMulterOptions: multer.Options = {
  storage,
  fileFilter: (req, file, cb) => {
    const logger = new LogWrapper('MulterStorage');
    const ext = path.extname(file.originalname).toLowerCase();
    if (ext !== '.csv') {
      logger.warn(`Rejected file ${file.originalname}: invalid extension`);
      return cb(new Error('Only .csv files are allowed') as any, false);
    }
    cb(null, true);
  },
  limits: {
    fileSize: 10 * 1024 * 1024,
  },
};
