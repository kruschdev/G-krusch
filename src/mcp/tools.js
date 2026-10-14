import { z } from 'zod';
import { getAgentSteering } from '../lib/steering.js';
import { searchDriveRag, syncDriveRag } from '../lib/rag.js';
import { readDriveFile, writeDriveFile, deleteDriveFile, listWorkspaceTree, resolvePathToId, getDriveOverview } from '../lib/drive.js';
import { listCalendarEvents, createCalendarEvent, searchGmailMessages, createOrSendGmail } from '../lib/extensions.js';
import { getAuthStatus } from '../lib/oauth.js';
import { getDb } from '../lib/db.js';
import config from '../config.js';

export function registerMcpTools(mcpServer) {

  // 1. Get Agent Steering (agent.md from Drive)
  mcpServer.tool(
    'get_agent_steering',
    'Retrieve the authoritative agent.md steering directives, persona rules, and active project state directly from Google Drive.',
    {
      force_refresh: z.boolean().default(false).describe('Force re-fetch from Google Drive ignoring local cache')
    },
    async ({ force_refresh }) => {
      try {
        const steering = await getAgentSteering({ forceRefresh: force_refresh });
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(steering, null, 2)
            }
          ]
        };
      } catch (err) {
        return {
          content: [{ type: 'text', text: `Error fetching agent steering from Google Drive: ${err.message}` }],
          isError: true
        };
      }
    }
  );

  // 2. Search Drive RAG (Semantic & hybrid search over Drive docs)
  mcpServer.tool(
    'search_drive_rag',
    'Perform semantic vector and keyword search across all indexed files in the Google Drive workspace.',
    {
      query: z.string().describe('Search query or question to retrieve context for'),
      limit: z.number().int().min(1).max(20).default(5).describe('Maximum number of matching chunks to return')
    },
    async ({ query, limit }) => {
      try {
        const results = await searchDriveRag(query, { limit });
        if (results.length === 0) {
          return {
            content: [{ type: 'text', text: `No relevant documents found in Google Drive for query: "${query}".` }]
          };
        }
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(results, null, 2)
            }
          ]
        };
      } catch (err) {
        return {
          content: [{ type: 'text', text: `Error searching Drive RAG: ${err.message}` }],
          isError: true
        };
      }
    }
  );

  // 3. Read Drive File (Google Docs -> Markdown, text files, code)
  mcpServer.tool(
    'read_drive_file',
    'Read the content of any document or file from Google Drive (Google Docs are automatically exported as clean markdown).',
    {
      file_id: z.string().optional().describe('Google Drive File ID'),
      path: z.string().optional().describe('Relative path in workspace (e.g. "context/spec.md", "agent.md")')
    },
    async ({ file_id, path }) => {
      try {
        let targetId = file_id;
        if (!targetId && path) {
          targetId = await resolvePathToId(path);
          if (!targetId) {
            return {
              content: [{ type: 'text', text: `File not found in workspace at path: "${path}"` }],
              isError: true
            };
          }
        }

        if (!targetId) {
          return {
            content: [{ type: 'text', text: 'Must provide either file_id or path.' }],
            isError: true
          };
        }

        const data = await readDriveFile(targetId);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                id: data.meta.id,
                name: data.meta.name,
                mimeType: data.meta.mimeType,
                webViewLink: data.meta.webViewLink,
                isBinary: data.isBinary || false,
                content: data.content
              }, null, 2)
            }
          ]
        };
      } catch (err) {
        return {
          content: [{ type: 'text', text: `Error reading file from Google Drive: ${err.message}` }],
          isError: true
        };
      }
    }
  );

  // 4. Write Drive File (Save documents, reports, updates to Drive)
  mcpServer.tool(
    'write_drive_file',
    'Create or update a document in Google Drive (e.g. saving an analysis, writing code snippets, or generating reports).',
    {
      path: z.string().describe('Relative path in workspace (e.g. "output/summary.md", "context/new-rules.md")'),
      content: z.string().describe('Text or markdown content to write'),
      mime_type: z.string().default('text/markdown').describe('MIME type (default: text/markdown)')
    },
    async ({ path, content, mime_type }) => {
      try {
        const result = await writeDriveFile({ path, content, mimeType: mime_type });
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result, null, 2)
            }
          ]
        };
      } catch (err) {
        return {
          content: [{ type: 'text', text: `Error writing file to Google Drive: ${err.message}` }],
          isError: true
        };
      }
    }
  );

  // 5. Delete Drive File (Trash a file or artifact)
  mcpServer.tool(
    'delete_drive_file',
    'Safely move a file inside the G-Krusch Google Drive workspace to trash.',
    {
      file_id: z.string().optional().describe('Google Drive File ID to delete'),
      path: z.string().optional().describe('Relative path in workspace (e.g. "output/temp.md")')
    },
    async ({ file_id, path }) => {
      try {
        if (!file_id && !path) {
          return {
            content: [{ type: 'text', text: 'Must provide either file_id or path to delete.' }],
            isError: true
          };
        }
        const result = await deleteDriveFile({ fileId: file_id, path });
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result, null, 2)
            }
          ]
        };
      } catch (err) {
        return {
          content: [{ type: 'text', text: `Error deleting file from Google Drive: ${err.message}` }],
          isError: true
        };
      }
    }
  );

  // 6. List Drive Workspace (Tree hierarchy)
  mcpServer.tool(
    'list_drive_workspace',
    'List all files and subdirectories inside the G-Krusch Google Drive workspace.',
    {},
    async () => {
      try {
        const tree = await listWorkspaceTree();
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(tree, null, 2)
            }
          ]
        };
      } catch (err) {
        return {
          content: [{ type: 'text', text: `Error listing Google Drive workspace: ${err.message}` }],
          isError: true
        };
      }
    }
  );

  // 7. Sync Drive RAG (Trigger fresh index)
  mcpServer.tool(
    'sync_drive_rag',
    'Trigger a fresh synchronization of Google Drive workspace files into the local vector RAG index.',
    {},
    async () => {
      try {
        const syncStats = await syncDriveRag();
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(syncStats, null, 2)
            }
          ]
        };
      } catch (err) {
        return {
          content: [{ type: 'text', text: `Error synchronizing Drive RAG: ${err.message}` }],
          isError: true
        };
      }
    }
  );

  // 8. Get Workspace Status (Diagnostic state)
  mcpServer.tool(
    'get_workspace_status',
    'Get real-time operational status of Google Drive connection, workspace root, and RAG index statistics.',
    {},
    async () => {
      try {
        const auth = getAuthStatus();
        let overview = null;
        if (auth.authenticated) {
          try {
            overview = await getDriveOverview();
          } catch {}
        }
        const db = getDb();
        const docCount = db.prepare('SELECT COUNT(*) as count FROM rag_documents').get()?.count || 0;
        const chunkCount = db.prepare('SELECT COUNT(*) as count FROM rag_chunks').get()?.count || 0;

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                status: auth.authenticated ? 'connected' : 'disconnected',
                account: auth.email,
                folderName: config.google.workspaceFolderName,
                documentsIndexed: docCount,
                totalChunks: chunkCount,
                storage: overview?.storage || null
              }, null, 2)
            }
          ]
        };
      } catch (err) {
        return {
          content: [{ type: 'text', text: `Error fetching workspace status: ${err.message}` }],
          isError: true
        };
      }
    }
  );

  // 9. List Google Calendar Events
  mcpServer.tool(
    'list_calendar_events',
    'List upcoming events from the user\'s primary Google Calendar.',
    {
      max_results: z.number().int().min(1).max(25).default(10).describe('Maximum number of upcoming events to return'),
      time_min: z.string().optional().describe('Optional ISO-8601 lower bound timestamp (defaults to now)'),
      query: z.string().optional().describe('Optional free-text search filter for event titles or descriptions')
    },
    async ({ max_results, time_min, query }) => {
      try {
        const events = await listCalendarEvents({
          maxResults: max_results,
          timeMin: time_min || null,
          query: query || ''
        });
        return {
          content: [{ type: 'text', text: JSON.stringify({ events }, null, 2) }]
        };
      } catch (err) {
        return {
          content: [{ type: 'text', text: `Error listing Google Calendar events: ${err.message}` }],
          isError: true
        };
      }
    }
  );

  // 10. Create Google Calendar Event
  mcpServer.tool(
    'create_calendar_event',
    'Schedule a new event or reservation hold on the user\'s primary Google Calendar.',
    {
      summary: z.string().describe('Title of the calendar event'),
      start_time: z.string().describe('ISO-8601 start timestamp (e.g. "2026-10-18T19:30:00-07:00")'),
      end_time: z.string().optional().describe('Optional ISO-8601 end timestamp (defaults to +1 hour)'),
      description: z.string().optional().describe('Optional event notes, booking links, or agenda'),
      location: z.string().optional().describe('Optional venue address or meeting link')
    },
    async ({ summary, start_time, end_time, description, location }) => {
      try {
        const event = await createCalendarEvent({
          summary,
          startTime: start_time,
          endTime: end_time || null,
          description: description || '',
          location: location || ''
        });
        return {
          content: [{ type: 'text', text: JSON.stringify({ event }, null, 2) }]
        };
      } catch (err) {
        return {
          content: [{ type: 'text', text: `Error creating Google Calendar event: ${err.message}` }],
          isError: true
        };
      }
    }
  );

  // 11. Search Gmail Messages
  mcpServer.tool(
    'search_gmail_messages',
    'Search messages in the user\'s Gmail inbox using standard Gmail search operators (e.g. "is:unread", "from:alex").',
    {
      query: z.string().default('is:inbox').describe('Gmail search query'),
      max_results: z.number().int().min(1).max(15).default(5).describe('Maximum number of matching messages to return')
    },
    async ({ query, max_results }) => {
      try {
        const messages = await searchGmailMessages({ query, maxResults: max_results });
        return {
          content: [{ type: 'text', text: JSON.stringify({ messages }, null, 2) }]
        };
      } catch (err) {
        return {
          content: [{ type: 'text', text: `Error searching Gmail messages: ${err.message}` }],
          isError: true
        };
      }
    }
  );

  // 12. Compose or Send Gmail Message
  mcpServer.tool(
    'compose_gmail_message',
    'Create a RFC-2822/RFC-2047 sanitized Gmail draft or send an email immediately (e.g. for reservations, follow-ups, or replies).',
    {
      to: z.string().describe('Recipient email address'),
      subject: z.string().describe('Email subject line'),
      body: z.string().describe('Plain-text email body'),
      send_immediately: z.boolean().default(false).describe('Set true to send the email immediately; false creates a Gmail draft')
    },
    async ({ to, subject, body, send_immediately }) => {
      try {
        const result = await createOrSendGmail({
          to,
          subject,
          body,
          sendImmediately: send_immediately
        });
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }]
        };
      } catch (err) {
        return {
          content: [{ type: 'text', text: `Error composing/sending Gmail message: ${err.message}` }],
          isError: true
        };
      }
    }
  );

}

