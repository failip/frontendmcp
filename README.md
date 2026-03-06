# FrontendMCP

## Overview

The Model Context Protocol (MCP) allows applications to provide context and
tools to LLMs in a standardized way. FrontendMCP extends this model to browser
environments.

This repository provides a lightweight relay and transport layer that allows MCP
servers to run in frontend applications, such as the main thread or Web Workers,
while remaining accessible to backend LLMs and other MCP clients.

This is particularly useful when the capabilities you want to expose already
exist in the browser: local state, browser-only APIs, UI logic, or frontend code
that makes authenticated backend requests on behalf of the current user.

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

mcpServer.registerTool("get_current_date", {
   title: 'Get Current Date',
   description: 'Returns the current date and time.',
   inputSchema: z.object({}).describe('No input required'),
   outputSchema: z.string().describe('Current date and time as a string'),
   },
   async () => {
      return new Date().toISOString();
   }

mcpServer.connect();

// Pass the servers url to your backend LLM or MCP client to start using the tool
const url = mcpServer.url;
```

Check out the [examples](./examples) directory for more complete implementations
and use cases.

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

- Client-side code execution in a sandboxed Web Worker or iframe via [FunctionBridge](https://github.com/failip/functionbridge)
- DOM inspection and UI orchestration
- Local state access without syncing data to a backend first
- Access to browser-exclusive APIs such as Geolocation or LocalStorage
- Exposing frontend functions that call authenticated backend endpoints using
  the current user's browser session
- Reducing backend implementation work when the required logic already exists in the frontend application

## Contributing

Issues and pull requests are welcome on GitHub.
