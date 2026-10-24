import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';

// Independent of files.ts so DATA_DIR is loaded before path constants are set.
const codeRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const projectRoot = existsSync(path.join(codeRoot, 'package.json'))
  ? codeRoot
  : path.dirname(codeRoot);
dotenv.config({ path: path.join(projectRoot, '.env'), quiet: true });
