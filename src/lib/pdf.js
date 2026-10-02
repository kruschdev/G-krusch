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

const execFileAsync = promisify(execFile);

const DEFAULT_NEXUS_PYTHON = '/home/krusch/homelab/projects/krusch-nexus/mcp_env/bin/python';
const DEFAULT_NEXUS_DIR = '/home/krusch/homelab/projects/krusch-nexus';

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
 * Parses a PDF buffer into structured page-cited chunks and text.
 * @param {Buffer} buffer - Raw PDF binary buffer
 * @param {string} filename - Original filename for citation grounding
 * @param {{ timeoutMs?: number }} [options]
 * @returns {Promise<{ text: string, chunks: Array<{ text: string, citation?: string, header?: string, pageNumber?: number, bbox?: number[] }>, engine: string }>}
 */
export async function parsePdfBuffer(buffer, filename = 'document.pdf', options = {}) {
  const timeoutMs = options.timeoutMs ?? 20000;
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'gcrush-pdf-'));
  const tempFilePath = path.join(tempDir, filename.endsWith('.pdf') ? filename : `${filename}.pdf`);

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
        ['-layout', filePath, '-'],
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

  throw new Error(`Unable to parse PDF "${name}". Neither Krusch-Nexus nor Poppler (pdftotext) is operational.`);
}
