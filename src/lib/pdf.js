/**
 * Krusch-Nexus & Poppler PDF Parsing Bridge for G-Krusch
 * 
 * Ingests PDF documents with physical page fidelity, section header extraction,
 * and canonical citation grounding:
 * - Tier 1: Krusch-Nexus library parser (air-gapped citation spine + OCR fallback)
 * - Tier 2: Poppler pdftotext (fast layout-preserving CLI fallback)
 */

import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import os from 'os';
import { execFile } from 'child_process';
import { promisify } from 'util';
import config from '../config.js';

const execFileAsync = promisify(execFile);

const DEFAULT_NEXUS_DIR = path.resolve(config.rootDir, '..', 'krusch-nexus');
const DEFAULT_NEXUS_PYTHON = path.join(DEFAULT_NEXUS_DIR, 'mcp_env', 'bin', 'python');

export function getNexusConfig() {
  const pythonPath = process.env.NEXUS_PYTHON || DEFAULT_NEXUS_PYTHON;
  const nexusDir = process.env.NEXUS_DIR || DEFAULT_NEXUS_DIR;
  const isAvailable = fs.existsSync(pythonPath) && fs.existsSync(nexusDir);
  return { pythonPath, nexusDir, isAvailable };
}

export function getPdftotextPath() {
  const paths = ['/usr/bin/pdftotext', '/usr/local/bin/pdftotext'];
  for (const p of paths) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

/**
 * Pre-spool magic-byte gate to reject disguised executables (PE/ELF/Mach-O), HTML, or non-PDF payloads
 * before writing temporary files to disk or invoking external parser processes.
 * @param {Buffer|Uint8Array} buffer
 */
export function validatePdfMagicBytes(buffer) {
  if (!buffer || !(Buffer.isBuffer(buffer) || buffer instanceof Uint8Array) || buffer.length < 5) {
    throw new Error('Invalid PDF payload: buffer is empty or too short.');
  }
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);

  // Explicit blocklist for executable / HTML masquerading (PE, ELF, Mach-O)
  if (buf[0] === 0x4d && buf[1] === 0x5a) {
    throw new Error('Security violation: Windows PE executable (MZ) disguised as PDF rejected before spooling.');
  }
  if (buf[0] === 0x7f && buf[1] === 0x45 && buf[2] === 0x4c && buf[3] === 0x46) {
    throw new Error('Security violation: ELF binary disguised as PDF rejected before spooling.');
  }
  if (buf.length >= 4) {
    const magic32 = buf.readUInt32BE(0);
    if (
      magic32 === 0xfeedface ||
      magic32 === 0xfeedfacf ||
      magic32 === 0xcefaedfe ||
      magic32 === 0xcffaedfe ||
      magic32 === 0xcafebabe
    ) {
      throw new Error('Security violation: Mach-O binary disguised as PDF rejected before spooling.');
    }
  }
  const headerSlice = buf.subarray(0, Math.min(buf.length, 1024)).toString('latin1');
  if (/^\s*<(!DOCTYPE|html|head|body|script|svg|iframe)/i.test(headerSlice)) {
    throw new Error('Security violation: HTML/script payload disguised as PDF rejected before spooling.');
  }
  const pdfIndex = headerSlice.indexOf('%PDF-');
  if (pdfIndex === -1 || pdfIndex > 16 || !/^[\s\xef\xbb\xbf]*%PDF-/.test(headerSlice)) {
    throw new Error('Invalid PDF payload: missing %PDF- magic header.');
  }
  return true;
}

/**
 * Sanitizes a PDF filename before writing to a local temporary directory or passing to CLI tools.
 * Strips path traversal segments, replaces unsafe characters, and prefixes leading hyphens.
 */
export function sanitizePdfTempName(filename = 'document.pdf') {
  const base = path.basename(String(filename || 'document.pdf').replace(/\\/g, '/'));
  let clean = base.replace(/[^a-zA-Z0-9._-]/g, '_').replace(/^\.+/, '');
  if (!clean) clean = 'document.pdf';
  if (clean.startsWith('-')) clean = `doc_${clean}`;
  if (!clean.toLowerCase().endsWith('.pdf')) clean = `${clean}.pdf`;
  return clean.slice(0, 120);
}

/**
 * Tier 3 pure-JS fallback extractor for uncompressed PDF text streams when neither
 * Krusch-Nexus nor Poppler pdftotext is installed (e.g., minimal CI containers).
 * @param {Buffer} buffer
 * @param {string} name
 */
export function extractPdfTextNative(buffer, name = 'document.pdf') {
  validatePdfMagicBytes(buffer);
  const raw = buffer.toString('latin1');
  const extractedTokens = [];

  const tjRegex = /\(([^()\\]*(?:\\.[^()\\]*)*)\)\s*Tj/g;
  let match;
  while ((match = tjRegex.exec(raw)) !== null) {
    const decoded = match[1]
      .replace(/\\n/g, '\n')
      .replace(/\\r/g, '\r')
      .replace(/\\t/g, '\t')
      .replace(/\\\(/g, '(')
      .replace(/\\\)/g, ')')
      .replace(/\\\\/g, '\\');
    if (decoded.trim()) extractedTokens.push(decoded.trim());
  }

  const tjArrayRegex = /\[([^\]]+)\]\s*TJ/g;
  while ((match = tjArrayRegex.exec(raw)) !== null) {
    const inner = match[1];
    const parts = [];
    const strRegex = /\(([^()\\]*(?:\\.[^()\\]*)*)\)/g;
    let sMatch;
    while ((sMatch = strRegex.exec(inner)) !== null) {
      parts.push(sMatch[1].replace(/\\\(/g, '(').replace(/\\\)/g, ')'));
    }
    if (parts.length > 0) {
      extractedTokens.push(parts.join(''));
    }
  }

  const pageText = extractedTokens.join('\n').trim();
  if (!pageText) return null;

  const citation = `${name} p.1`;
  return {
    text: `[${citation}]\n${pageText}`,
    chunks: [
      {
        text: pageText,
        citation,
        header: null,
        pageNumber: 1,
        bbox: null
      }
    ],
    engine: 'native'
  };
}

/**
 * Parses a PDF buffer into structured page-cited chunks and text.
 * @param {Buffer} buffer - Raw PDF binary buffer
 * @param {string} filename - Original filename for citation grounding
 * @param {{ timeoutMs?: number }} [options]
 * @returns {Promise<{ text: string, chunks: Array<{ text: string, citation?: string, header?: string, pageNumber?: number, bbox?: number[] }>, engine: string }>}
 */
export async function parsePdfBuffer(buffer, filename = 'document.pdf', options = {}) {
  validatePdfMagicBytes(buffer);
  const timeoutMs = options.timeoutMs ?? 20000;
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'gcrush-pdf-'));
  const safeFileName = sanitizePdfTempName(filename);
  const tempFilePath = path.join(tempDir, safeFileName);

  try {
    await fsp.writeFile(tempFilePath, buffer);
    return await parsePdfFile(tempFilePath, filename, { ...options, timeoutMs });
  } finally {
    try {
      await fsp.rm(tempDir, { recursive: true, force: true });
    } catch {}
  }
}

/**
 * Parses a local PDF file into structured chunks.
 * @param {string} filePath - Absolute path to PDF file
 * @param {string} filename - Filename for citation formatting
 * @param {{ timeoutMs?: number }} [options]
 */
export async function parsePdfFile(filePath, filename, options = {}) {
  const timeoutMs = options.timeoutMs ?? 20000;
  const name = filename || path.basename(filePath);
  const fileBuffer = await fsp.readFile(filePath);
  validatePdfMagicBytes(fileBuffer);

  // 1. Try Krusch-Nexus Tier 1 (Page-grounded citation spine)
  const nexus = getNexusConfig();
  if (nexus.isAvailable) {
    try {
      const { stdout } = await execFileAsync(
        nexus.pythonPath,
        ['-m', 'krusch_nexus.cli', 'parse', filePath, '--jsonl'],
        {
          cwd: nexus.nexusDir,
          timeout: timeoutMs,
          maxBuffer: 10 * 1024 * 1024
        }
      );

      const lines = stdout.split('\n').filter(l => l.trim().length > 0);
      const chunks = [];

      for (const line of lines) {
        try {
          const item = JSON.parse(line);
          chunks.push({
            text: item.text || item.raw_text || '',
            citation: item.citation || `${name} p.${item.page_number || 1}`,
            header: item.header || null,
            pageNumber: item.page_number || item.pdf_page || 1,
            bbox: item.bbox || null
          });
        } catch {}
      }

      if (chunks.length > 0) {
        const fullText = chunks
          .map(c => `[${c.citation}]\n${c.text}`)
          .join('\n\n---\n\n');

        return {
          text: fullText,
          chunks,
          engine: 'nexus'
        };
      }
    } catch (nexusErr) {
      console.warn('[PDF] Nexus parse failed or timed out, falling back to pdftotext:', nexusErr.message);
    }
  }

  // 2. Try Poppler pdftotext Tier 2
  const pdftotextBin = getPdftotextPath();
  if (pdftotextBin) {
    try {
      const { stdout } = await execFileAsync(
        pdftotextBin,
        ['-layout', '--', filePath, '-'],
        { timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024 }
      );

      // pdftotext uses Form Feed \x0c between physical pages
      const rawPages = stdout.split('\x0c');
      const chunks = [];

      for (let i = 0; i < rawPages.length; i++) {
        const pageText = rawPages[i].trim();
        if (!pageText) continue;
        const pageNum = i + 1;
        chunks.push({
          text: pageText,
          citation: `${name} p.${pageNum}`,
          header: null,
          pageNumber: pageNum,
          bbox: null
        });
      }

      if (chunks.length > 0) {
        const fullText = chunks
          .map(c => `[${c.citation}]\n${c.text}`)
          .join('\n\n---\n\n');

        return {
          text: fullText,
          chunks,
          engine: 'pdftotext'
        };
      }
    } catch (popplerErr) {
      console.warn('[PDF] pdftotext failed:', popplerErr.message);
    }
  }

  // 3. Tier 3 pure-JS native PDF stream fallback
  const nativeParsed = extractPdfTextNative(fileBuffer, name);
  if (nativeParsed) {
    return nativeParsed;
  }

  throw new Error(`Unable to parse PDF "${name}". Neither Krusch-Nexus nor Poppler (pdftotext) is operational.`);
}
