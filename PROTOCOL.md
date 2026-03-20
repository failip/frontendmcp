# FrontendMCP Protocol

FrontendMCP is a transport bridge that lets an MCP client (an LLM host or agent) talk to an MCP server running inside a browser or Web Worker, using a relay server to cross the network boundary.

## Actors

| Actor | Role |
| :--- | :--- |
| **MCP Client** | Sends JSON-RPC requests to the relay over HTTP/SSE |
| **Relay Server** | Stateful in-memory bridge; speaks HTTP+SSE north-side and WebSocket south-side |
| **Frontend App** | Browser/Worker running the MCP server; connected via WebSocket |

---

## 1. Session Setup

1. The **Frontend App** generates a cryptographically random UUID (`crypto.randomUUID()`).
2. It opens a WebSocket to `wss://relay/mcp/ws/:uuid`.
3. The **first message** sent on the WebSocket must be a JSON auth packet:
   ```json
   { "token": "<secret-or-empty-string>" }
   ```
4. The relay registers the session in memory. Until this message arrives, all HTTP traffic to `/mcp/:uuid` is rejected with `404`.

---

## 2. Message Framing

All WebSocket messages (in both directions) are plain UTF-8 strings with a fixed 6-byte header:

```
┌─────────────┬─────────────┬──────────────────────┐
│ requestId   │ status      │ payload              │
│ 3 hex chars │ 3 chars     │ JSON string (or empty)│
└─────────────┴─────────────┴──────────────────────┘
```

### Status field values

| Value | Direction | Meaning |
| :--- | :--- | :--- |
| `200`–`599` | Frontend → Relay | Final HTTP response; closes the pending request |
| `202` | Frontend → Relay | Notification acknowledged; no HTTP body returned |
| `CHK` | Frontend → Relay | Streaming chunk; SSE stream stays open |

### Request ID

A 3-hex-digit counter (`000`–`fff`, wrapping) scoped to the session. The relay allocates the next free slot (skipping any IDs still waiting for a response) so in-flight requests are never clobbered.

---

## 3. Relay → Frontend App (HTTP POST)

```
MCP Client                  Relay                    Frontend App
    │                          │                           │
    │  POST /mcp/:uuid         │                           │
    │  Accept: application/json│                           │
    │─────────────────────────▶│                           │
    │                          │  WS: "001" + JSON body    │
    │                          │──────────────────────────▶│
    │                          │                           │  (process)
    │                          │  WS: "001200" + JSON resp │
    │                          │◀──────────────────────────│
    │  HTTP 200 + JSON body    │                           │
    │◀─────────────────────────│                           │
```

1. Relay assigns a request ID and stores a one-shot resolve callback.
2. It publishes `requestId + body` over WebSocket.
3. Frontend processes the request and sends back `requestId + statusCode + responseBody`.
4. Relay resolves the HTTP response with the correct status and body.
5. If no reply arrives within **240 seconds**, the relay returns `504 Gateway Timeout` and removes the pending entry.

---

## 4. Streaming (SSE) Response

When the MCP client sends `Accept: text/event-stream`, the relay opens an SSE response immediately and streams events as the frontend produces them.

```
MCP Client                  Relay                    Frontend App
    │                          │                           │
    │  POST /mcp/:uuid         │                           │
    │  Accept: text/event-stream                           │
    │─────────────────────────▶│                           │
    │  SSE stream opens        │  WS: "001" + JSON body    │
    │◀─────────────────────────│──────────────────────────▶│
    │                          │                           │  (chunk 1)
    │                          │  WS: "001CHK" + chunk     │
    │  data: chunk 1           │◀──────────────────────────│
    │◀─────────────────────────│                           │  (chunk 2)
    │                          │  WS: "001CHK" + chunk     │
    │  data: chunk 2           │◀──────────────────────────│
    │                          │                           │  (final)
    │                          │  WS: "001200" + body      │
    │  data: final body        │◀──────────────────────────│
    │  [stream closed]         │                           │
```

* `CHK` messages forward a chunk without closing the pending entry.
* A numeric status closes the SSE stream and removes the pending entry.
* If the MCP client disconnects, the stream's `cancel()` callback removes the pending entry and clears the timer.

---

## 5. Server-to-Client Push (GET SSE)

The MCP spec allows the server to push JSON-RPC requests and notifications to the client unprompted. The Frontend App does this by holding a long-lived SSE channel open:

```
MCP Client                  Relay                    Frontend App
    │                          │                           │
    │  GET /mcp/:uuid          │                           │
    │  Accept: text/event-stream                           │
    │─────────────────────────▶│                           │
    │  SSE stream opens        │                           │
    │◀─────────────────────────│                           │
    │                          │◀── WS push notification ──│
    │  data: notification      │                           │
    │◀─────────────────────────│                           │
```

Multiple SSE streams per session are supported. Each gets a unique integer ID; a `Drop`/`cancel` guard removes it from the session when the client disconnects.

---

## 6. Session Teardown

| Trigger | Behaviour |
| :--- | :--- |
| `DELETE /mcp/:uuid` | Explicit client termination; closes all SSE streams, deletes session |
| WebSocket closes | Same cleanup; all pending requests time out or are dropped |
| 240 s timeout | Individual request cancelled; session remains alive |

---

## 7. Security Considerations

* **UUID unpredictability**: Without a token, the UUID is the only secret. Always use `crypto.randomUUID()`.
* **Bearer token**: When set, every HTTP request to `/mcp/:uuid` must carry `Authorization: Bearer <token>`.
* **TLS required**: Run the relay behind HTTPS/WSS. The token and all JSON-RPC payloads travel in plaintext otherwise.
* **No persistence**: The relay is strictly in-memory. No payloads are written to disk or logged.