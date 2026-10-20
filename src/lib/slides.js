import zlib from 'zlib';

const PPTX_MIME = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
const GOOGLE_SLIDES_MIME = 'application/vnd.google-apps.presentation';
const GOOGLE_DOCS_MIME = 'application/vnd.google-apps.document';
const GOOGLE_SHEETS_MIME = 'application/vnd.google-apps.spreadsheet';

export { PPTX_MIME, GOOGLE_SLIDES_MIME, GOOGLE_DOCS_MIME, GOOGLE_SHEETS_MIME };

/**
 * Determine whether a write_drive_file call targets a Google Slides presentation.
 */
export function isSlidesTarget(relativePath = '', mimeType = '') {
  const normalizedMime = String(mimeType || '').trim().toLowerCase();
  const normalizedPath = String(relativePath || '').trim().toLowerCase();
  if (
    normalizedMime === GOOGLE_SLIDES_MIME ||
    normalizedMime === PPTX_MIME ||
    normalizedMime === 'slides' ||
    normalizedMime === 'google-slides'
  ) {
    return true;
  }
  return normalizedPath.endsWith('.slides') || normalizedPath.endsWith('.gslides');
}

/**
 * Determine whether a write_drive_file call targets a native Google Doc.
 */
export function isDocsTarget(relativePath = '', mimeType = '') {
  const normalizedMime = String(mimeType || '').trim().toLowerCase();
  const normalizedPath = String(relativePath || '').trim().toLowerCase();
  if (
    normalizedMime === GOOGLE_DOCS_MIME ||
    normalizedMime === 'doc' ||
    normalizedMime === 'docs' ||
    normalizedMime === 'gdoc' ||
    normalizedMime === 'google-doc' ||
    normalizedMime === 'google-docs'
  ) {
    return true;
  }
  return normalizedPath.endsWith('.gdoc');
}

/**
 * Determine whether a write_drive_file call targets a native Google Sheet.
 */
export function isSheetsTarget(relativePath = '', mimeType = '') {
  const normalizedMime = String(mimeType || '').trim().toLowerCase();
  const normalizedPath = String(relativePath || '').trim().toLowerCase();
  if (
    normalizedMime === GOOGLE_SHEETS_MIME ||
    normalizedMime === 'sheet' ||
    normalizedMime === 'sheets' ||
    normalizedMime === 'gsheet' ||
    normalizedMime === 'google-sheet' ||
    normalizedMime === 'google-sheets'
  ) {
    return true;
  }
  return normalizedPath.endsWith('.gsheet') || normalizedPath.endsWith('.sheet');
}

function escapeHtml(str = '') {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatInlineMarkdownToHtml(text = '') {
  let out = escapeHtml(text);
  out = out.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/(^|[^*])\*([^*]+)\*(?!\*)/g, '$1<em>$2</em>');
  out = out.replace(/`([^`]+)`/g, '<code>$1</code>');
  out = out.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2">$1</a>');
  return out;
}

/**
 * Convert Markdown (or HTML) into clean semantic HTML so Google Drive API v3
 * imports it as a rich native Google Doc with real headings, lists, and formatting.
 */
export function markdownToGoogleDocHtml(content = '', title = 'Document') {
  const raw = String(content || '').replace(/\r\n/g, '\n').trim();
  if (/^\s*<!doctype html/i.test(raw) || /^\s*<html[\s>]/i.test(raw)) {
    return raw;
  }

  const lines = raw.split('\n');
  const htmlParts = [];
  let inList = false;

  const closeList = () => {
    if (inList) {
      htmlParts.push('</ul>');
      inList = false;
    }
  };

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      closeList();
      continue;
    }

    if (/^---\s*$/.test(trimmed)) {
      closeList();
      htmlParts.push('<hr/>');
      continue;
    }

    const headingMatch = trimmed.match(/^(#{1,6})\s+(.*)$/);
    if (headingMatch) {
      closeList();
      const level = headingMatch[1].length;
      htmlParts.push(`<h${level}>${formatInlineMarkdownToHtml(headingMatch[2].trim())}</h${level}>`);
      continue;
    }

    const bulletMatch = trimmed.match(/^[-*+]\s+(.*)$/);
    if (bulletMatch) {
      if (!inList) {
        htmlParts.push('<ul>');
        inList = true;
      }
      htmlParts.push(`<li>${formatInlineMarkdownToHtml(bulletMatch[1].trim())}</li>`);
      continue;
    }

    closeList();
    htmlParts.push(`<p>${formatInlineMarkdownToHtml(trimmed)}</p>`);
  }

  closeList();

  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>${escapeHtml(title)}</title></head><body>${htmlParts.join('\n')}</body></html>`;
}

function escapeCsvCell(cell = '') {
  const str = String(cell ?? '').trim();
  if (/[",\r\n]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

/**
 * Convert either a Markdown pipe table (`| A | B |`) or raw CSV into valid RFC-4180 CSV
 * so Google Drive API v3 imports it as a native Google Sheet.
 */
export function markdownTableOrTextToCsv(content = '') {
  const raw = String(content || '').replace(/\r\n/g, '\n').trim();
  if (!raw) return '';

  const lines = raw.split('\n').map(l => l.trim()).filter(Boolean);
  const looksLikeMarkdownTable = lines.length >= 2 && lines.every(l => l.includes('|'));

  if (!looksLikeMarkdownTable) {
    return raw;
  }

  const csvRows = [];
  for (const line of lines) {
    const stripped = line.replace(/^\|/, '').replace(/\|$/, '');
    const cells = stripped.split('|').map(c => c.trim());
    // Skip markdown separator row like |---|---|
    if (cells.every(c => /^:?-{2,}:?$/.test(c))) {
      continue;
    }
    csvRows.push(cells.map(escapeCsvCell).join(','));
  }

  return csvRows.join('\r\n');
}

/**
 * Parse Markdown or plain text into an array of structured slides:
 *   [{ title: string, bullets: string[], notes: string }]
 *
 * Supports:
 * - Explicit slide breaks via `---` on its own line
 * - Multi-section documents split by `# ` or `## ` headings when no `---` is present
 * - Optional speaker notes via `Notes:` or `<!-- notes: ... -->`
 */
export function parseMarkdownSlides(content = '', fallbackTitle = 'Presentation') {
  const raw = String(content || '').replace(/\r\n/g, '\n').trim();
  const cleanFallback = String(fallbackTitle || 'Presentation').replace(/\.(slides|gslides|pptx|md)$/i, '');

  if (!raw) {
    return [{ title: cleanFallback, bullets: [''], notes: '' }];
  }

  let rawBlocks;
  if (/^---\s*$/m.test(raw)) {
    rawBlocks = raw
      .split(/^---\s*$/m)
      .map(s => s.trim())
      .filter(Boolean);
  } else {
    const headingSplits = raw
      .split(/(?=^#{1,2}\s+)/m)
      .map(s => s.trim())
      .filter(Boolean);
    rawBlocks = headingSplits.length > 1 ? headingSplits : [raw];
  }

  return rawBlocks.map((block, idx) => {
    let notes = '';
    let mainBlock = block;

    const htmlNoteMatch = mainBlock.match(/<!--\s*notes?:\s*([\s\S]*?)-->/i);
    if (htmlNoteMatch) {
      notes = htmlNoteMatch[1].trim();
      mainBlock = mainBlock.replace(htmlNoteMatch[0], '').trim();
    }

    const lines = mainBlock.split('\n');
    let title = '';
    const bullets = [];
    let inNotesSection = false;
    const noteLines = [];

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      if (/^(?:speaker\s+)?notes?:\s*$/i.test(trimmed)) {
        inNotesSection = true;
        continue;
      }
      if (inNotesSection) {
        noteLines.push(trimmed.replace(/^[-*+]\s+/, ''));
        continue;
      }

      const headingMatch = trimmed.match(/^#{1,6}\s+(.*)$/);
      if (headingMatch && !title) {
        title = headingMatch[1].trim();
        continue;
      }

      if (!title && bullets.length === 0 && !/^[-*+]\s+/.test(trimmed) && !/^\d+\.\s+/.test(trimmed)) {
        title = trimmed;
        continue;
      }

      const cleanedBullet = trimmed
        .replace(/^[-*+]\s+/, '')
        .replace(/^\d+\.\s+/, '')
        .replace(/\*\*(.*?)\*\*/g, '$1')
        .replace(/`(.*?)`/g, '$1');
      bullets.push(cleanedBullet);
    }

    if (noteLines.length > 0) {
      notes = [notes, noteLines.join('\n')].filter(Boolean).join('\n');
    }

    if (!title) {
      title = idx === 0 ? cleanFallback : `Slide ${idx + 1}`;
    }

    return {
      title: title.slice(0, 300),
      bullets: bullets.length > 0 ? bullets : [''],
      notes: notes.slice(0, 2000)
    };
  });
}

function escapeXml(str = '') {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * CRC-32 implementation for standard ZIP archive headers.
 */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * Minimal in-memory ZIP builder for OpenXML (.pptx) archives.
 */
function buildZipBuffer(entries) {
  const localFileHeaders = [];
  const centralDirectoryHeaders = [];
  let offset = 0;

  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, 'utf8');
    const uncompressed = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8');
    const compressed = zlib.deflateRawSync(uncompressed);
    const crc = crc32(uncompressed);

    const localHeader = Buffer.alloc(30 + nameBuf.length);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0, 6);
    localHeader.writeUInt16LE(8, 8);
    localHeader.writeUInt16LE(0, 10);
    localHeader.writeUInt16LE(0x21, 12);
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(compressed.length, 18);
    localHeader.writeUInt32LE(uncompressed.length, 22);
    localHeader.writeUInt16LE(nameBuf.length, 26);
    localHeader.writeUInt16LE(0, 28);
    nameBuf.copy(localHeader, 30);

    localFileHeaders.push(localHeader, compressed);

    const centralHeader = Buffer.alloc(46 + nameBuf.length);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0, 8);
    centralHeader.writeUInt16LE(8, 10);
    centralHeader.writeUInt16LE(0, 12);
    centralHeader.writeUInt16LE(0x21, 14);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(compressed.length, 20);
    centralHeader.writeUInt32LE(uncompressed.length, 24);
    centralHeader.writeUInt16LE(nameBuf.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(0, 38);
    centralHeader.writeUInt32LE(offset, 42);
    nameBuf.copy(centralHeader, 46);

    centralDirectoryHeaders.push(centralHeader);
    offset += localHeader.length + compressed.length;
  }

  const centralDirBuffer = Buffer.concat(centralDirectoryHeaders);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralDirBuffer.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...localFileHeaders, centralDirBuffer, eocd]);
}

function buildSlideXml(slide) {
  const paragraphs = slide.bullets
    .filter(b => b !== undefined && b !== null)
    .map(bullet => {
      const text = escapeXml(bullet);
      if (!text) {
        return `<a:p><a:endParaRPr lang="en-US" sz="2000"/></a:p>`;
      }
      return `<a:p><a:pPr marL="342900" indent="-342900"><a:buChar char="•"/></a:pPr><a:r><a:rPr lang="en-US" sz="2000" dirty="0"><a:solidFill><a:srgbClr val="1E293B"/></a:solidFill></a:rPr><a:t>${text}</a:t></a:r></a:p>`;
    })
    .join('');

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld>
    <p:spTree>
      <p:nvGrpSpPr>
        <p:cNvPr id="1" name=""/>
        <p:cNvGrpSpPr/>
        <p:nvPr/>
      </p:nvGrpSpPr>
      <p:grpSpPr>
        <a:xfrm>
          <a:off x="0" y="0"/>
          <a:ext cx="0" cy="0"/>
          <a:chOff x="0" y="0"/>
          <a:chExt cx="0" cy="0"/>
        </a:xfrm>
      </p:grpSpPr>
      <p:sp>
        <p:nvSpPr>
          <p:cNvPr id="2" name="Title 1"/>
          <p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr>
          <p:nvPr><p:ph type="title"/></p:nvPr>
        </p:nvSpPr>
        <p:spPr>
          <a:xfrm>
            <a:off x="685800" y="457200"/>
            <a:ext cx="10820400" cy="1143000"/>
          </a:xfrm>
        </p:spPr>
        <p:txBody>
          <a:bodyPr/>
          <a:lstStyle/>
          <a:p>
            <a:r>
              <a:rPr lang="en-US" sz="3200" b="1" dirty="0">
                <a:solidFill><a:srgbClr val="0F172A"/></a:solidFill>
              </a:rPr>
              <a:t>${escapeXml(slide.title)}</a:t>
            </a:r>
          </a:p>
        </p:txBody>
      </p:sp>
      <p:sp>
        <p:nvSpPr>
          <p:cNvPr id="3" name="Content Placeholder 2"/>
          <p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr>
          <p:nvPr><p:ph idx="1"/></p:nvPr>
        </p:nvSpPr>
        <p:spPr>
          <a:xfrm>
            <a:off x="685800" y="1828800"/>
            <a:ext cx="10820400" cy="4572000"/>
          </a:xfrm>
        </p:spPr>
        <p:txBody>
          <a:bodyPr/>
          <a:lstStyle/>
          ${paragraphs || '<a:p><a:endParaRPr lang="en-US"/></a:p>'}
        </p:txBody>
      </p:sp>
    </p:spTree>
  </p:cSld>
  <p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>
</p:sld>`;
}

/**
 * Build a complete, standards-compliant OpenXML (.pptx) buffer from Markdown or structured slides.
 * Google Drive API v3 automatically converts this buffer into a native Google Slides deck
 * when uploaded with requestBody.mimeType = 'application/vnd.google-apps.presentation'.
 */
export function buildPptxBuffer(slidesInput, fallbackTitle = 'Presentation') {
  const slides = Array.isArray(slidesInput)
    ? slidesInput
    : parseMarkdownSlides(slidesInput, fallbackTitle);

  const entries = [];

  const slideContentTypes = slides
    .map((_, idx) => `<Override PartName="/ppt/slides/slide${idx + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`)
    .join('\n  ');

  entries.push({
    name: '[Content_Types].xml',
    data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>
  <Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/>
  <Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/>
  <Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>
  ${slideContentTypes}
</Types>`
  });

  entries.push({
    name: '_rels/.rels',
    data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/>
</Relationships>`
  });

  const slideRels = slides
    .map((_, idx) => `<Relationship Id="rId${idx + 2}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${idx + 1}.xml"/>`)
    .join('\n  ');

  entries.push({
    name: 'ppt/_rels/presentation.xml.rels',
    data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="slideMasters/slideMaster1.xml"/>
  ${slideRels}
  <Relationship Id="rIdTheme" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="theme/theme1.xml"/>
</Relationships>`
  });

  const sldIdLst = slides
    .map((_, idx) => `<p:sldId id="${256 + idx}" r:id="rId${idx + 2}"/>`)
    .join('\n    ');

  entries.push({
    name: 'ppt/presentation.xml',
    data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:sldMasterIdLst>
    <p:sldMasterId id="2147483648" r:id="rId1"/>
  </p:sldMasterIdLst>
  <p:sldIdLst>
    ${sldIdLst}
  </p:sldIdLst>
  <p:sldSz cx="12192000" cy="6858000" type="screen16x9"/>
  <p:notesSz cx="6858000" cy="9144000"/>
</p:presentation>`
  });

  entries.push({
    name: 'ppt/slideMasters/_rels/slideMaster1.xml.rels',
    data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="../theme/theme1.xml"/>
</Relationships>`
  });

  entries.push({
    name: 'ppt/slideMasters/slideMaster1.xml',
    data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sldMaster xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld>
    <p:spTree>
      <p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
      <p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>
    </p:spTree>
  </p:cSld>
  <p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>
  <p:sldLayoutIdLst>
    <p:sldLayoutId id="2147483649" r:id="rId1"/>
  </p:sldLayoutIdLst>
</p:sldMaster>`
  });

  entries.push({
    name: 'ppt/slideLayouts/_rels/slideLayout1.xml.rels',
    data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="../slideMasters/slideMaster1.xml"/>
</Relationships>`
  });

  entries.push({
    name: 'ppt/slideLayouts/slideLayout1.xml',
    data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sldLayout xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" type="obj">
  <p:cSld name="Title and Content">
    <p:spTree>
      <p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
      <p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>
    </p:spTree>
  </p:cSld>
  <p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>
</p:sldLayout>`
  });

  entries.push({
    name: 'ppt/theme/theme1.xml',
    data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="G-Krusch Theme">
  <a:themeElements>
    <a:clrScheme name="G-Krusch">
      <a:dk1><a:srgbClr val="0F172A"/></a:dk1>
      <a:lt1><a:srgbClr val="FFFFFF"/></a:lt1>
      <a:dk2><a:srgbClr val="1E293B"/></a:dk2>
      <a:lt2><a:srgbClr val="F8FAFC"/></a:lt2>
      <a:accent1><a:srgbClr val="2563EB"/></a:accent1>
      <a:accent2><a:srgbClr val="0EA5E9"/></a:accent2>
      <a:accent3><a:srgbClr val="10B981"/></a:accent3>
      <a:accent4><a:srgbClr val="F59E0B"/></a:accent4>
      <a:accent5><a:srgbClr val="8B5CF6"/></a:accent5>
      <a:accent6><a:srgbClr val="EC4899"/></a:accent6>
      <a:hlink><a:srgbClr val="2563EB"/></a:hlink>
      <a:folHlink><a:srgbClr val="7C3AED"/></a:folHlink>
    </a:clrScheme>
    <a:fontScheme name="G-Krusch Fonts">
      <a:majorFont><a:latin typeface="Arial"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont>
      <a:minorFont><a:latin typeface="Arial"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont>
    </a:fontScheme>
    <a:fmtScheme name="G-Krusch">
      <a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:fillStyleLst>
      <a:lnStyleLst><a:ln w="9525"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="9525"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="9525"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln></a:lnStyleLst>
      <a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst>
      <a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:bgFillStyleLst>
    </a:fmtScheme>
  </a:themeElements>
</a:theme>`
  });

  slides.forEach((slide, idx) => {
    const slideNum = idx + 1;
    entries.push({
      name: `ppt/slides/_rels/slide${slideNum}.xml.rels`,
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>
</Relationships>`
    });
    entries.push({
      name: `ppt/slides/slide${slideNum}.xml`,
      data: buildSlideXml(slide)
    });
  });

  return buildZipBuffer(entries);
}

/**
 * Prepare target Drive metadata and upload media payload for Google Slides, Google Docs,
 * Google Sheets, or standard file uploads.
 */
export function prepareWorkspaceWritePayload({ fileName, content = '', mimeType = 'text/markdown' }) {
  if (isSlidesTarget(fileName, mimeType)) {
    const cleanName = fileName.replace(/\.(slides|gslides)$/i, '');
    const parsedSlides = parseMarkdownSlides(content, cleanName);
    const pptxBuffer = buildPptxBuffer(parsedSlides, cleanName);
    return {
      targetName: cleanName,
      targetMimeType: GOOGLE_SLIDES_MIME,
      uploadMimeType: PPTX_MIME,
      uploadBuffer: pptxBuffer,
      extraMeta: { slidesCount: parsedSlides.length }
    };
  }

  if (isDocsTarget(fileName, mimeType)) {
    const cleanName = fileName.replace(/\.gdoc$/i, '');
    const html = markdownToGoogleDocHtml(content, cleanName);
    return {
      targetName: cleanName,
      targetMimeType: GOOGLE_DOCS_MIME,
      uploadMimeType: 'text/html',
      uploadBuffer: Buffer.from(html, 'utf8'),
      extraMeta: {}
    };
  }

  if (isSheetsTarget(fileName, mimeType)) {
    const cleanName = fileName.replace(/\.(gsheet|sheet)$/i, '');
    const csv = markdownTableOrTextToCsv(content);
    return {
      targetName: cleanName,
      targetMimeType: GOOGLE_SHEETS_MIME,
      uploadMimeType: 'text/csv',
      uploadBuffer: Buffer.from(csv, 'utf8'),
      extraMeta: {}
    };
  }

  return {
    targetName: fileName,
    targetMimeType: mimeType || 'text/markdown',
    uploadMimeType: mimeType || 'text/markdown',
    uploadBuffer: Buffer.from(content || '', 'utf8'),
    extraMeta: {}
  };
}
