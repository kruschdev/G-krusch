import { z } from 'zod';
import { getAgentSteering } from '../lib/steering.js';
import { searchDriveRag, syncDriveRag } from '../lib/rag.js';
import { readDriveFile, writeDriveFile, listWorkspaceTree, resolvePathToId } from '../lib/drive.js';

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

  // 5. List Drive Workspace (Tree hierarchy)
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

  // 6. Sync Drive RAG (Trigger fresh index)
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

}
