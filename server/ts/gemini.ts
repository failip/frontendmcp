import { GoogleGenAI, mcpToTool } from '@google/genai';
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

export async function handleGeminiMCP(request: Request) {
  const body = await request.json();

  const mcpServers = body.mcp_servers || [];
  const serverUrl = mcpServers[0]?.url;

  const prompt = body.input;
  const url = new URL(serverUrl);

  const serverParams = new StreamableHTTPClientTransport(url);

  const client = new Client({
    name: "mcp-client",
    version: "1.0.0",
  });

  // Configure the client
  const ai = new GoogleGenAI(
    {
      apiKey: process.env.GOOGLE_API_KEY,
    }
  );

  // Initialize the connection between client and server
  await client.connect(serverParams);

  console.log(client.listTools());

  // Send request to the model with MCP tools
  const response = await ai.models.generateContent({
    model: body.model || "gemini-2.5-flash-lite",
    contents: prompt,
    config: {
      tools: [mcpToTool(client)],
    },
  });

  console.log(response.text);

  // Close the connection
  await client.close();

  return new Response(JSON.stringify({ response: response.text }), {
    headers: {
      'Content-Type': 'application/json'
    }
  });
}