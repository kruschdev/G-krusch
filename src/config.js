import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

dotenv.config({ path: path.join(rootDir, '.env') });

export const config = {
  port: parseInt(process.env.PORT || '5446', 10),
  baseUrl: process.env.BASE_URL || `http://localhost:${process.env.PORT || '5446'}`,
  rootDir,
  dataDir: path.join(rootDir, 'data'),
  dbPath: path.resolve(rootDir, process.env.DATABASE_PATH || './data/gcrush.db'),
  google: {
    clientId: process.env.GOOGLE_CLIENT_ID || '',
    clientSecret: process.env.GOOGLE_CLIENT_SECRET || '',
    redirectUri: process.env.GOOGLE_REDIRECT_URI || `http://localhost:${process.env.PORT || '5446'}/auth/google/callback`,
    scopes: [
      'https://www.googleapis.com/auth/drive',
      'https://www.googleapis.com/auth/drive.file',
      'https://www.googleapis.com/auth/drive.readonly',
      'https://www.googleapis.com/auth/userinfo.email',
      'https://www.googleapis.com/auth/userinfo.profile'
    ],
    workspaceFolderName: process.env.WORKSPACE_FOLDER_NAME || 'G-Krusch',
    folderId: process.env.GOOGLE_DRIVE_FOLDER_ID || null
  },
  ai: {
    geminiApiKey: process.env.GEMINI_API_KEY || '',
    ollamaUrl: process.env.OLLAMA_URL || 'http://localhost:11434/api/embeddings',
    ollamaModel: process.env.OLLAMA_MODEL || 'nomic-embed-text'
  }
};

export default config;
