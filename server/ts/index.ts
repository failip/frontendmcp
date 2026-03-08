import { handleLLM } from './llm';

const resolveReplyPromises = new Map<string, (value: string) => void>();
const authTokens = new Map<string, string>();
const activeWebSockets = new Set<string>();

async function handleWS(request: Request, server: Bun.Server<{ uuid: string }>) {
	const uuid = request.params.uuid;
	if (activeWebSockets.has(uuid)) {
		return new Response('WebSocket connection already exists', { status: 409 });
	}

	activeWebSockets.add(uuid);
	const success = server.upgrade(request, { data: { uuid } });
	if (success) return undefined;

	activeWebSockets.delete(uuid);
	return new Response('WebSocket upgrade failed', { status: 400 });
}

async function handleMCP(request: Request, server: Bun.Server<{ uuid: string }>) {
	const uuid = request.params.uuid;

	if (request.method === 'GET' && request.headers.get('accept')?.includes('text/event-stream')) {
		return new Response(new ReadableStream({
			start(controller) {
				controller.enqueue(`id: ${Date.now()}\nevent: connected\ndata: {"status":"connected"}\n\n`);
			}
		}), {
			headers: {
				'Content-Type': 'text/event-stream',
				'Cache-Control': 'no-cache',
				'Connection': 'keep-alive',
				'Mcp-Session-Id': uuid,
			}
		});
	}

	const expectedToken = authTokens.get(uuid);
	const authHeader = request.headers.get('authorization');
	if (expectedToken === undefined || (expectedToken !== '' && authHeader !== `Bearer ${expectedToken}`)) {
		return new Response('Unauthorized', { status: 401 });
	}

	const body = await request.text();

	const replyPromise = new Promise<string>((resolve) => {
		resolveReplyPromises.set(uuid, resolve);
	});

	server.publish(uuid, body);

	const reply = await replyPromise;
	const status = Number.parseInt(reply.substring(0, 3));
	const content = reply.substring(3);
	return new Response(content || null, {
		status: Number.isNaN(status) ? 200 : status,
		headers: {
			'Content-Type': 'application/json',
			'Mcp-Session-Id': uuid
		}
	});
}

const server = Bun.serve<{ uuid: string }>({
	routes: {
		'/mcp/:uuid': handleMCP,
		'/mcp/ws/:uuid': handleWS,
		'/llm': handleLLM
	},
	websocket: {
		open(ws) {
			console.log(`WebSocket opened for session ${ws.data.uuid}`);
			ws.subscribe(ws.data.uuid);
		},
		message(ws, message) {
			if (!authTokens.has(ws.data.uuid)) {
				if (typeof message === 'string') {
					try {
						const data = JSON.parse(message);
						authTokens.set(ws.data.uuid, data.token);
					} catch (e) { }
				}
				return;
			}

			const resolve = resolveReplyPromises.get(ws.data.uuid);
			if (resolve) {
				resolveReplyPromises.delete(ws.data.uuid);
				resolve(message as any);
			}
		},
		close(ws) {
			resolveReplyPromises.delete(ws.data.uuid);
			authTokens.delete(ws.data.uuid);
			activeWebSockets.delete(ws.data.uuid);
			ws.unsubscribe(ws.data.uuid);
		}
	}
});

console.log(`Listening on ${server.hostname}:${server.port}`);
