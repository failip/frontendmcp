# FrontendMCP Protocol Overview

The FrontendMCP protocol is a lightweight transport bridge that allows an MCP Client (which expects a standard HTTP-based MCP server) to communicate with an MCP Server running in a browser environment.

It involves three main actors:
1. **MCP Client**: The LLM or application requesting tools/context.
2. **Relay Server**: An intermediate server that bridges HTTP requests to WebSockets.
3. **Frontend Application**: The browser or Web Worker running the `FrontendMCPServer`.

## 1. Connection Phase

1. The **Frontend Application** generates a unique UUID (or is provided one).
2. The **Frontend Application** establishes a WebSocket connection to the **Relay Server** at `/mcp/ws/:uuid`.
3. Upon opening the WebSocket connection, the **Frontend Application** immediately sends a JSON authorization message (`{ type: 'auth', token: '...' }`) to authenticate the session.
4. The **Relay Server** stores this session mapping and subscribes the WebSocket to messages for that UUID.

## 2. Request/Response Flow

1. The **MCP Client** sends a standard MCP JSON-RPC payload via HTTP POST to the **Relay Server** at `/mcp/:uuid`.
   * *If an expected authentication token is set, the client must provide it in the `Authorization: Bearer <token>` header.*
2. The **Relay Server** publishes the raw JSON body over the WebSocket to the associated **Frontend Application**.
3. The **Frontend Application** receives the JSON-RPC message, processes the tool execution or request, and generates a response.
4. The **Frontend Application** sends the response back over the WebSocket. To support HTTP status codes via WebSocket, the response is prefixed with a 3-digit status code (e.g., `200{"jsonrpc": "2.0", ...}` or `202`).
5. The **Relay Server** intercepts this WebSocket message, strips the 3-digit status code prefix, and resolves the original pending HTTP request, sending the remaining payload back to the **MCP Client** with the correct HTTP status.

## 3. Privacy & Security

The FrontendMCP protocol is designed to be as secure and private as your infrastructure and implementation allow. 

* **No Data Persistence**: The Relay Server acts strictly as an in-memory pass-through bridge. It holds WebSocket connections and pending HTTP requests temporarily and does not persist JSON-RPC payloads or tool data to disk.
* **Session Predictability**: The security of unauthenticated sessions relies entirely on the unpredictability of the UUID. Always use cryptographically secure UUIDs (e.g., `crypto.randomUUID()`).
* **Authentication**: For sensitive environments, implement the authorization token mechanism. This ensures that even if a UUID is known, the MCP Client cannot interact with the Frontend Application without the matching Bearer token.
* **Transport Security**: The protocol relies on standard web security practices. You must serve your Relay Server over TLS (`https://` and `wss://`) to prevent man-in-the-middle attacks, token interception, and payload eavesdropping.
