# FrontendMCP

## Overview

The Model Context Protocol (MCP) allows applications to provide context for LLMs
in a standardized way. FrontendMCP extends this capability to the browser.

This repository contains a lightweight relay and transport layer that
allows you to run MCP servers in frontend applications (such as Web Workers or
the main thread) and expose them to backend LLMs or other MCP clients.

## Installation

```bash
npm install frontendmcp
```

## Usage

```javascript
import { FrontendMCPServer } from 'frontendmcp';
import { z } from 'zod/v4';

const mcpServer = new FrontendMCPServer(
   {version: '1.0', name: 'My MCP Server'},
);

mcpServer.connect();

mcpServer.registerTool("get_current_date", {
   title: 'Get Current Date',
   description: 'Returns the current date and time.',
   inputSchema: z.object({}).describe('No input required'),
   outputSchema: z.string().describe('Current date and time as a string'),
   },
   async () => {
      return new Date().toISOString();
   }
);

// Pass the servers url to your backend LLM or MCP client to start using the tool
const url = mcpServer.url;
```

Check out the [examples](./examples) directory for more complete implementations and use cases.

## Architecture

Standard MCP clients typically communicate over HTTP or STDIO. FrontendMCP
bridges this gap for browser environments:

1. The relay server listens for incoming HTTP requests from an MCP client.
2. The frontend establishes a persistent WebSocket connection to the relay
   server using a unique UUID.
3. When the relay server receives an HTTP request for a specific UUID, it
   forwards the JSON-RPC message over the WebSocket.
4. The frontend MCP server processes the request and sends the response back
   through the WebSocket.
5. The relay server completes the HTTP request with the frontend's response.

## Use Cases

- Client-side code execution in a sandboxed Web Worker
- DOM inspection and manipulation
- Local state access without syncing to a backend database
- Access to browser-exclusive APIs like Geolocation or LocalStorage

## Contributing

Issues and pull requests are welcome on GitHub.
