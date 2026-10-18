import dotenv from 'dotenv';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

dotenv.config({ path: path.join(rootDir, '.env') });

const isTestRuntime =
  process.env.NODE_ENV === 'test' ||
  process.execArgv.includes('--test') ||
  process.argv.some(arg => arg.endsWith('.test.js'));

const resolvedDbPath = isTestRuntime
  ? path.resolve(process.env.GCRUSH_TEST_DB_PATH || path.join(os.tmpdir(), `gcrush-test-${process.pid}.db`))
  : path.resolve(rootDir, process.env.DATABASE_PATH || './data/gcrush.db');

export const config = {
  port: parseInt(process.env.PORT || '5446', 10),
  baseUrl: process.env.BASE_URL || `http://localhost:${process.env.PORT || '5446'}`,
  rootDir,
  isTestRuntime,
  dataDir: isTestRuntime ? path.dirname(resolvedDbPath) : path.join(rootDir, 'data'),
  dbPath: resolvedDbPath,
  google: {
    clientId: process.env.GOOGLE_CLIENT_ID || '',
    clientSecret: process.env.GOOGLE_CLIENT_SECRET || '',
    redirectUri: process.env.GOOGLE_REDIRECT_URI || `http://localhost:${process.env.PORT || '5446'}/auth/google/callback`,
    scopes: [
      'https://www.googleapis.com/auth/drive',
      'https://www.googleapis.com/auth/drive.file',
      'https://www.googleapis.com/auth/drive.readonly',
      'https://www.googleapis.com/auth/calendar.events',
      'https://www.googleapis.com/auth/calendar.readonly',
      'https://www.googleapis.com/auth/gmail.readonly',
      'https://www.googleapis.com/auth/gmail.compose',
      'https://www.googleapis.com/auth/gmail.send',
      'https://www.googleapis.com/auth/userinfo.email',
      'https://www.googleapis.com/auth/userinfo.profile'
    ],
    workspaceFolderName: process.env.WORKSPACE_FOLDER_NAME || 'G-Krusch',
    folderId: process.env.GOOGLE_DRIVE_FOLDER_ID || null
  },
  ai: {
    geminiApiKey: process.env.GEMINI_API_KEY || '',
    ollamaUrl: process.env.OLLAMA_URL || 'http://localhost:11434/api/embeddings',
    ollamaModel: process.env.OLLAMA_MODEL || 'bge-large:latest'
  }
};

export default config;
