# FrontendMCP: Model Context Protocol for the Browser

<div align="center">
    <picture>
      <img src="./docs/assets/frontendmcp-wordmark.svg" alt="FrontendMCP Logo" width="500"/>
    </picture>
    <div align="left">
      <a href="https://www.npmjs.com/package/frontendmcp">
        <img src="https://img.shields.io/npm/v/frontendmcp" alt="npm version" />
      </a>
    </div>
</div>


## Overview

The [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) allows applications to provide context and
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
import { z } from 'zod';

const mcp = new FrontendMCPServer({
  name: 'ClientTools',
  version: '1.0'
});

mcp.registerTool('get_selection', {
  description: 'Read highlighted text',
  inputSchema: z.object({})
}, async () => ({
  content: [{
    type: 'text',
    text: window.getSelection()?.toString() || ""
  }]
}));

mcp.connect();

// Pass the server's URL to your backend LLM or MCP client to start using the tool
const url = mcp.url;
```

Check out the [examples](./examples) directory for more complete implementations
and use cases.

## Architecture

Standard MCP clients typically communicate over Streaming HTTP or STDIO. FrontendMCP
bridges this gap for browser environments:

1. The relay server listens for incoming HTTP requests from an MCP client.
2. The frontend establishes a persistent WebSocket connection to the relay
   server using a unique UUID.
3. When the relay server receives an HTTP request for a specific UUID, it
   forwards the JSON-RPC message over the WebSocket.
4. The frontend MCP server processes the request and sends the response back
   through the WebSocket.
5. The relay server completes the HTTP request with the frontend's response.

The full protocol is detailed in [PROTOCOL.md](./PROTOCOL.md) and the reference implementations are available in the [server](./server) directory.

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
