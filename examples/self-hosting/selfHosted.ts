import { FrontendMCPServer } from 'frontendmcp';
import { z } from 'zod/v4';

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'your_anthropic_api_key_here';

async function main() {
  // create and configure a frontend MCP server
  const mcpServer = new FrontendMCPServer({
    version: '1.0', name: 'My MCP Server',
    frontendMCP: {
      mcpServerUrl: 'https://your-custom-domain.com/mcp',
      websocketUrl: 'wss://your-custom-domain.com/mcp/ws',
    }
  });

  mcpServer.registerTool(
    'get_current_date',
    {
      title: 'Get Current Date',
      description: 'Returns the current date and time.',
      inputSchema: z.object({}).describe('No input required'),
    },
    async () => {
      return {
        content: [
          {
            type: 'text',
            text: new Date().toISOString(),
          },
        ],
        isError: false,
      };
    }
  );

  mcpServer.connect();

  // build an MCP message that uses the toolset exposed by the frontend server
  const prompt = 'What is the current date and time?';
  const message = {
    model: 'claude-haiku-4-5',
    max_tokens: 1000,
    messages: [{ role: 'user', content: prompt }],
    mcp_servers: [
      {
        type: 'url',
        url: mcpServer.url,
        name: 'FrontendMCP Server',
      },
    ],
    tools: [
      {
        type: 'mcp_toolset',
        mcp_server_name: 'FrontendMCP Server',
      },
    ],
  };

  // development: relay via frontendmcp
  const resp = await fetch('https://mcp.frontendmcp.com/llm', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
    },
    body: JSON.stringify(message),
  });

  const data = await resp.json();
  console.log('llm response', data);

  // production: send to Anthropic API from your backend
  // await fetch('https://api.anthropic.com/v1/messages', { ... });
}

main().catch(console.error);
