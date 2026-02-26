import { handleLLM } from "./llm";

const resolveReplyPromises = new Map<string, (value: string) => void>();

async function handleMCP(request: Request, server: Bun.Server<{ uuid: string }>) {
  const uuid = request.params.uuid;
  const body = request.body.text();

  const replyPromise = new Promise<string>((resolve) => {
    resolveReplyPromises.set(uuid, resolve);
  });

  server.publish(uuid, await body);
  const reply = await replyPromise;
  const status = Number.parseInt(reply.substring(0, 3));
  const content = reply.substring(3);
  return new Response(content, { status: status, headers: { "Content-Type": "application/json" } });
}

const server = Bun.serve<{ uuid: string }>({
  routes: {
    "/mcp/:uuid": handleMCP,
    "/llm": handleLLM,
  },
  fetch(req, server) {
    const url = new URL(req.url);
    const uuid = url.searchParams.get("uuid");
    if (!uuid) {
      return new Response("Missing uuid query parameter", { status: 400 });
    }
    const success = server.upgrade(req, { data: { uuid } });
    if (success) return undefined;
    return new Response("Connect via WebSocket.", { status: 400 });
  },
  websocket: {
    open(ws) {
      ws.subscribe(ws.data.uuid);
    },
    message(ws, message) {
      const resolve = resolveReplyPromises.get(ws.data.uuid);
      if (resolve) {
        resolveReplyPromises.delete(ws.data.uuid);
        resolve(message);
      }
    },
    close(ws) {
      resolveReplyPromises.delete(ws.data.uuid);
      ws.unsubscribe(ws.data.uuid);
    },
  },
});

console.log(`Listening on ${server.hostname}:${server.port}`);