import { google } from 'googleapis';
import { getAuthenticatedClient } from './oauth.js';
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

/**
 * List upcoming events from the user's primary Google Calendar.
 */
export async function listCalendarEvents({ maxResults = 10, timeMin = null, query = '' } = {}) {
  const auth = await getAuthenticatedClient();
  const calendar = google.calendar({ version: 'v3', auth });

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
    calendarId: 'primary',
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
    summary: ev.summary || '(No Title)',
    start: ev.start?.dateTime || ev.start?.date || null,
    end: ev.end?.dateTime || ev.end?.date || null,
    location: ev.location || null,
    description: ev.description || null,
    htmlLink: ev.htmlLink || null
  }));
}

/**
 * Create a new event on the user's primary Google Calendar.
 */
export async function createCalendarEvent({ summary, startTime, endTime = null, description = '', location = '' } = {}) {
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

  const res = await withRetry(() =>
    calendar.events.insert({
      calendarId: 'primary',
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
  const detailed = [];

  for (const msg of messages) {
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

    detailed.push({
      id: detail.data.id,
      threadId: detail.data.threadId,
      from: getHeader('From'),
      to: getHeader('To'),
      subject: getHeader('Subject'),
      date: getHeader('Date'),
      snippet: detail.data.snippet || ''
    });
  }

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

