import { LogWrapper } from "@utils/LogWrapper";
import * as fs from "fs";
import * as multer from "multer";
import * as path from "path";

export const storage = multer.diskStorage({
  destination: async (req, file, cb) => {
    const logger = new LogWrapper("MulterStorage");

    try {
      const uploadRoot = "uploads";

      if (!fs.existsSync(uploadRoot)) {
        fs.mkdirSync(uploadRoot, { recursive: true });
      }

      cb(null, uploadRoot);
    } catch (error) {
      await logger.error("Error in destination callback");
      cb(error, null);
    }
  },
  filename: async (req, file, cb) => {
    const logger = new LogWrapper("MulterStorage");

    try {
      const originalExtension = path.extname(file.originalname);
      const uniqueSuffix = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
      cb(null, `${file.fieldname}-${uniqueSuffix}${originalExtension}`);
    } catch (error) {
      await logger.error("Error in filename callback");
      cb(error, null);
    }
  },
});
