import { google } from 'googleapis';
import { getAuthenticatedClient } from './oauth.js';
import { withRetry } from './retry.js';

/**
 * List upcoming events from the user's primary Google Calendar.
 */
export async function listCalendarEvents({ maxResults = 10, timeMin = null, query = '' } = {}) {
  const auth = await getAuthenticatedClient();
  const calendar = google.calendar({ version: 'v3', auth });

  const params = {
    calendarId: 'primary',
    timeMin: timeMin || new Date().toISOString(),
    maxResults: Math.min(Math.max(1, maxResults), 25),
    singleEvents: true,
    orderBy: 'startTime'
  };
  if (query && query.trim()) {
    params.q = query.trim();
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
export async function createCalendarEvent({ summary, startTime, endTime = null, description = '', location = '' }) {
  if (!summary || !startTime) {
    throw new Error('summary and startTime (ISO-8601) are required to create a calendar event.');
  }

  const auth = await getAuthenticatedClient();
  const calendar = google.calendar({ version: 'v3', auth });

  const startDate = new Date(startTime);
  if (isNaN(startDate.getTime())) {
    throw new Error(`Invalid startTime ISO string: "${startTime}"`);
  }

  const endDate = endTime ? new Date(endTime) : new Date(startDate.getTime() + 60 * 60 * 1000);

  const res = await withRetry(() =>
    calendar.events.insert({
      calendarId: 'primary',
      requestBody: {
        summary,
        description,
        location,
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

  const listRes = await withRetry(() =>
    gmail.users.messages.list({
      userId: 'me',
      q: query || 'is:inbox',
      maxResults: Math.min(Math.max(1, maxResults), 15)
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
 */
export function encodeRawEmail({ to, subject, body }) {
  const lines = [
    `To: ${to}`,
    `Subject: ${subject}`,
    'Content-Type: text/plain; charset="UTF-8"',
    'MIME-Version: 1.0',
    '',
    body
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
export async function createOrSendGmail({ to, subject, body, sendImmediately = false }) {
  if (!to || !subject || !body) {
    throw new Error('to, subject, and body are required for Gmail compose.');
  }

  const auth = await getAuthenticatedClient();
  const gmail = google.gmail({ version: 'v1', auth });
  const raw = encodeRawEmail({ to, subject, body });

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
