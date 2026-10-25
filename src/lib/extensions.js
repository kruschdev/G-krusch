import { google } from 'googleapis';
import { getAuthenticatedClient } from './oauth.js';
import { setMetadata, getMetadata } from './db.js';
import { withRetry } from './retry.js';

const MAX_EMAIL_BODY_BYTES = 256 * 1024; // 256 KB safety cap for composed emails
const EMAIL_REGEX = /^[^\s@<>,"\r\n]+@[^\s@<>,"\r\n]+\.[^\s@<>,"\r\n]+$/;

/**
 * Strip CR/LF and control characters from header fields to prevent SMTP/MIME Header Injection.
 */
export function sanitizeHeaderValue(value) {
  return String(value || '')
    .replace(/[\r\n\x00-\x1F\x7F]+/g, ' ')
    .trim();
}

/**
 * Validate a recipient email address (supports "Name <user@domain.com>" or "user@domain.com").
 */
export function validateEmailAddress(raw) {
  const clean = sanitizeHeaderValue(raw);
  if (!clean) {
    throw new Error('Recipient email address ("to") is required.');
  }
  const angleMatch = clean.match(/<([^<>]+)>$/);
  const addr = angleMatch ? angleMatch[1].trim() : clean;
  if (!EMAIL_REGEX.test(addr)) {
    throw new Error(`Invalid recipient email address: "${clean}"`);
  }
  return clean;
}

/**
 * Encode non-ASCII header text per RFC 2047 (=?UTF-8?B?...?=) while keeping pure ASCII readable.
 */
export function encodeMimeSubject(subject) {
  const clean = sanitizeHeaderValue(subject);
  if (/^[\x20-\x7E]*$/.test(clean)) {
    return clean;
  }
  return `=?UTF-8?B?${Buffer.from(clean, 'utf-8').toString('base64')}?=`;
}

export function getCalendarProfiles() {
  let savedFamilyId = null;
  let savedGrandparentsId = null;
  try {
    savedFamilyId = getMetadata('skylight_family_calendar_id');
    savedGrandparentsId = getMetadata('skylight_grandparents_calendar_id');
  } catch {
    // DB not initialized in unit tests
  }
  const familyLabel = process.env.GOOGLE_FAMILY_CALENDAR_LABEL || 'Family';
  return {
    family: {
      key: 'family',
      label: familyLabel,
      calendarId:
        process.env.GOOGLE_FAMILY_CALENDAR_ID ||
        savedFamilyId ||
        'primary',
      description: process.env.GOOGLE_FAMILY_CALENDAR_DESCRIPTION || 'Dedicated Skylight Family Calendar'
    },
    grandparents: {
      key: 'grandparents',
      label: process.env.GOOGLE_GRANDPARENTS_CALENDAR_LABEL || 'Grandparents',
      calendarId:
        process.env.GOOGLE_GRANDPARENTS_CALENDAR_ID ||
        savedGrandparentsId ||
        'primary',
      description:
        process.env.GOOGLE_GRANDPARENTS_CALENDAR_DESCRIPTION || 'Dedicated Skylight Grandparents Calendar'
    }
  };
}

export const SKYLIGHT_FRAME_EMAIL = (process.env.SKYLIGHT_MAGIC_IMPORT_EMAIL || '').trim();

/**
 * Provision two dedicated secondary Google Calendars for Skylight ("Family" and "Grandparents")
 * so the personal primary calendar remains untouched, and optionally share them with SKYLIGHT_MAGIC_IMPORT_EMAIL.
 */
export async function ensureSkylightCalendars() {
  const auth = await getAuthenticatedClient();
  const calendar = google.calendar({ version: 'v3', auth });
  const listRes = await withRetry(() => calendar.calendarList.list());
  const existing = listRes.data.items || [];

  const configuredFamilyLabel = (process.env.GOOGLE_FAMILY_CALENDAR_LABEL || 'Family').trim();
  const familyMatchLabels = new Set(
    [configuredFamilyLabel.toLowerCase(), 'skylight family', 'family'].filter(Boolean)
  );

  let familyCal = existing.find(
    c => !c.primary && familyMatchLabels.has(String(c.summary || '').trim().toLowerCase())
  );

  if (!familyCal) {
    try {
      const created = await withRetry(() =>
        calendar.calendars.insert({
          requestBody: {
            summary: configuredFamilyLabel,
            description:
              process.env.GOOGLE_FAMILY_CALENDAR_DESCRIPTION || 'Dedicated Skylight Family Calendar',
            timeZone: process.env.CALENDAR_TIMEZONE || 'America/Los_Angeles'
          }
        })
      );
      familyCal = created.data;
    } catch {
      const fallbackFamilyId = process.env.GOOGLE_FAMILY_CALENDAR_ID || 'primary';
      familyCal = existing.find(c => c.id === fallbackFamilyId) || {
        id: fallbackFamilyId,
        summary: configuredFamilyLabel
      };
    }
  }

  const configuredGrandparentsLabel = (
    process.env.GOOGLE_GRANDPARENTS_CALENDAR_LABEL || 'Grandparents'
  ).trim();
  const grandparentsMatchLabels = new Set(
    [configuredGrandparentsLabel.toLowerCase(), 'grandparents', 'skylight grandparents'].filter(Boolean)
  );

  let grandparentsCal = existing.find(
    c => !c.primary && grandparentsMatchLabels.has(String(c.summary || '').trim().toLowerCase())
  );

  let createdDedicatedGrandparents = Boolean(grandparentsCal);
  if (!grandparentsCal) {
    try {
      const created = await withRetry(() =>
        calendar.calendars.insert({
          requestBody: {
            summary: configuredGrandparentsLabel,
            description:
              process.env.GOOGLE_GRANDPARENTS_CALENDAR_DESCRIPTION ||
              'Dedicated Skylight Grandparents Calendar',
            timeZone: process.env.CALENDAR_TIMEZONE || 'America/Los_Angeles'
          }
        })
      );
      grandparentsCal = created.data;
      createdDedicatedGrandparents = true;
    } catch {
      const fallbackPrimary = process.env.GOOGLE_LOGIN_HINT || 'primary';
      grandparentsCal = existing.find(c => c.primary) || {
        id: fallbackPrimary,
        summary: configuredGrandparentsLabel
      };
    }
  }

  for (const cal of [familyCal, grandparentsCal]) {
    if (cal?.id && SKYLIGHT_FRAME_EMAIL) {
      try {
        await calendar.acl.insert({
          calendarId: cal.id,
          requestBody: {
            role: 'reader',
            scope: { type: 'user', value: SKYLIGHT_FRAME_EMAIL }
          }
        });
      } catch {
        // Ignore if ACL rule already exists or scope only covers events
      }
    }
  }

  if (familyCal?.id) {
    setMetadata('skylight_family_calendar_id', familyCal.id);
  }
  if (grandparentsCal?.id) {
    setMetadata('skylight_grandparents_calendar_id', grandparentsCal.id);
  }

  return {
    ok: true,
    createdDedicatedGrandparents,
    skylightFrameEmail: SKYLIGHT_FRAME_EMAIL,
    familyCalendar: { id: familyCal.id, summary: familyCal.summary },
    grandparentsCalendar: { id: grandparentsCal.id, summary: grandparentsCal.summary },
    profiles: getCalendarProfiles()
  };
}

function parseAliasList(envVar, defaults) {
  const extra = String(process.env[envVar] || '')
    .split(',')
    .map(s => s.trim().toLowerCase())
    .filter(Boolean);
  return new Set([...defaults, ...extra]);
}

/**
 * Resolve a friendly calendar alias ("family", "grandparents", "primary", plus optional .env aliases)
 * or raw Google Calendar ID.
 */
export function resolveCalendarId(rawCalendarId = 'primary') {
  const clean = sanitizeHeaderValue(rawCalendarId || 'primary');
  if (!clean) return 'primary';
  const lower = clean.toLowerCase();
  const profiles = getCalendarProfiles();

  const familyAliases = parseAliasList('GOOGLE_FAMILY_CALENDAR_ALIASES', ['family', 'household', 'ours']);
  if (familyAliases.has(lower)) {
    return profiles.family.calendarId;
  }

  const grandparentsAliases = parseAliasList('GOOGLE_GRANDPARENTS_CALENDAR_ALIASES', [
    'grandparents',
    'grandparent',
    'grandma',
    'mom',
    'together',
    'shared'
  ]);
  if (grandparentsAliases.has(lower)) {
    return profiles.grandparents.calendarId;
  }

  const primaryAliases = parseAliasList('GOOGLE_PRIMARY_CALENDAR_ALIASES', ['primary', 'personal', 'default']);
  if (primaryAliases.has(lower)) {
    return 'primary';
  }
  return clean;
}

/**
 * List available Google Calendars and configured Skylight calendar profiles.
 */
export async function listUserCalendars() {
  const auth = await getAuthenticatedClient();
  const calendar = google.calendar({ version: 'v3', auth });
  const res = await withRetry(() => calendar.calendarList.list());
  const items = (res.data.items || []).map(c => ({
    id: c.id,
    summary: c.summary,
    primary: Boolean(c.primary),
    accessRole: c.accessRole,
    timeZone: c.timeZone
  }));
  return {
    profiles: getCalendarProfiles(),
    calendars: items
  };
}

/**
 * List upcoming events from the specified Google Calendar (defaults to primary).
 */
export async function listCalendarEvents({ maxResults = 10, timeMin = null, query = '', calendarId = 'primary' } = {}) {
  const auth = await getAuthenticatedClient();
  const calendar = google.calendar({ version: 'v3', auth });
  const targetCalendarId = resolveCalendarId(calendarId);

  let resolvedTimeMin = new Date().toISOString();
  if (timeMin) {
    const parsedMin = new Date(timeMin);
    if (isNaN(parsedMin.getTime())) {
      throw new Error(`Invalid timeMin ISO string: "${timeMin}"`);
    }
    resolvedTimeMin = parsedMin.toISOString();
  }

  const safeLimit = Number.isFinite(Number(maxResults))
    ? Math.min(Math.max(1, Number(maxResults)), 25)
    : 10;

  const params = {
    calendarId: targetCalendarId,
    timeMin: resolvedTimeMin,
    maxResults: safeLimit,
    singleEvents: true,
    orderBy: 'startTime'
  };
  if (query && String(query).trim()) {
    params.q = String(query).trim().slice(0, 200);
  }

  const res = await withRetry(() => calendar.events.list(params));
  const items = res.data.items || [];

  return items.map(ev => ({
    id: ev.id,
    calendarId: targetCalendarId,
    summary: ev.summary || '(No Title)',
    start: ev.start?.dateTime || ev.start?.date || null,
    end: ev.end?.dateTime || ev.end?.date || null,
    location: ev.location || null,
    description: ev.description || null,
    htmlLink: ev.htmlLink || null
  }));
}

/**
 * Create a new event on the specified Google Calendar (defaults to primary).
 */
export async function createCalendarEvent({
  summary,
  startTime,
  endTime = null,
  description = '',
  location = '',
  calendarId = 'primary'
} = {}) {
  const cleanSummary = sanitizeHeaderValue(summary).slice(0, 500);
  if (!cleanSummary || !startTime) {
    throw new Error('summary and startTime (ISO-8601) are required to create a calendar event.');
  }

  const startDate = new Date(startTime);
  if (isNaN(startDate.getTime())) {
    throw new Error(`Invalid startTime ISO string: "${startTime}"`);
  }

  let endDate;
  if (endTime) {
    endDate = new Date(endTime);
    if (isNaN(endDate.getTime())) {
      throw new Error(`Invalid endTime ISO string: "${endTime}"`);
    }
    if (endDate.getTime() <= startDate.getTime()) {
      throw new Error('endTime must be later than startTime.');
    }
  } else {
    endDate = new Date(startDate.getTime() + 60 * 60 * 1000);
  }

  const auth = await getAuthenticatedClient();
  const calendar = google.calendar({ version: 'v3', auth });
  const targetCalendarId = resolveCalendarId(calendarId);

  const res = await withRetry(() =>
    calendar.events.insert({
      calendarId: targetCalendarId,
      requestBody: {
        summary: cleanSummary,
        description: String(description || '').slice(0, 8000),
        location: sanitizeHeaderValue(location).slice(0, 500),
        start: { dateTime: startDate.toISOString() },
        end: { dateTime: endDate.toISOString() }
      }
    })
  );

  return {
    id: res.data.id,
    calendarId: targetCalendarId,
    summary: res.data.summary,
    start: res.data.start?.dateTime || res.data.start?.date,
    end: res.data.end?.dateTime || res.data.end?.date,
    htmlLink: res.data.htmlLink
  };
}

/**
 * Search messages in the user's Gmail inbox.
 */
export async function searchGmailMessages({ query = 'is:inbox', maxResults = 5 } = {}) {
  const auth = await getAuthenticatedClient();
  const gmail = google.gmail({ version: 'v1', auth });

  const safeLimit = Number.isFinite(Number(maxResults))
    ? Math.min(Math.max(1, Number(maxResults)), 15)
    : 5;
  const cleanQuery = String(query || 'is:inbox').trim().slice(0, 300) || 'is:inbox';

  const listRes = await withRetry(() =>
    gmail.users.messages.list({
      userId: 'me',
      q: cleanQuery,
      maxResults: safeLimit
    })
  );

  const messages = listRes.data.messages || [];
  const detailed = await Promise.all(
    messages.map(async (msg) => {
      const detail = await withRetry(() =>
        gmail.users.messages.get({
          userId: 'me',
          id: msg.id,
          format: 'metadata',
          metadataHeaders: ['From', 'To', 'Subject', 'Date']
        })
      );
      const headers = detail.data.payload?.headers || [];
      const getHeader = (name) => headers.find(h => h.name.toLowerCase() === name.toLowerCase())?.value || '';

      return {
        id: detail.data.id,
        threadId: detail.data.threadId,
        from: getHeader('From'),
        to: getHeader('To'),
        subject: getHeader('Subject'),
        date: getHeader('Date'),
        snippet: detail.data.snippet || ''
      };
    })
  );

  return detailed;
}

/**
 * Encode an RFC 2822 email message in base64url format for the Gmail API.
 * Strictly strips CRLF from headers to prevent MIME header injection.
 */
export function encodeRawEmail({ to, subject, body }) {
  const safeTo = validateEmailAddress(to);
  const safeSubject = encodeMimeSubject(subject || '(No Subject)');
  const rawBody = String(body ?? '');

  if (Buffer.byteLength(rawBody, 'utf-8') > MAX_EMAIL_BODY_BYTES) {
    throw new Error('Email body exceeds maximum allowed size of 256KB.');
  }

  const normalizedBody = rawBody.replace(/\r?\n/g, '\r\n');
  const lines = [
    `To: ${safeTo}`,
    `Subject: ${safeSubject}`,
    'Content-Type: text/plain; charset="UTF-8"',
    'MIME-Version: 1.0',
    '',
    normalizedBody
  ];
  return Buffer.from(lines.join('\r\n'), 'utf-8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/**
 * Create a Gmail draft or send an email directly.
 */
export async function createOrSendGmail({ to, subject, body, sendImmediately = false } = {}) {
  if (!to || !subject || !body) {
    throw new Error('to, subject, and body are required for Gmail compose.');
  }

  const raw = encodeRawEmail({ to, subject, body });
  const auth = await getAuthenticatedClient();
  const gmail = google.gmail({ version: 'v1', auth });

  if (sendImmediately) {
    const sent = await withRetry(() =>
      gmail.users.messages.send({
        userId: 'me',
        requestBody: { raw }
      })
    );
    return {
      mode: 'sent',
      id: sent.data.id,
      threadId: sent.data.threadId
    };
  }

  const draft = await withRetry(() =>
    gmail.users.drafts.create({
      userId: 'me',
      requestBody: {
        message: { raw }
      }
    })
  );

  return {
    mode: 'draft',
    id: draft.data.id,
    messageId: draft.data.message?.id
  };
}

