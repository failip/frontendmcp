import { handleGeminiMCP } from './gemini';
import { handleGemini, handleLLM as handleAnthropic } from './llm';

interface Session {
	authToken: string;
	seq: number;
	pendingRequests: Map<string, ({ status, content }: { status: number; content: string }) => void>;
	// SSE streams open via GET — server can push notifications/requests on these
	sseStreams: Set<ReadableStreamDefaultController<string>>;
}

// Single source of truth per session
const sessions = new Map<string, Session>();

function getNextRequestId(session: Session): string {
	session.seq = (session.seq + 1) & 0xfff;
	return session.seq.toString(16).padStart(3, '0');
}

async function handleWS(request: Request, server: Bun.Server<{ uuid: string }>) {
	const uuid = request.params.uuid;
	if (sessions.has(uuid)) {
		return new Response('WebSocket connection already exists', { status: 409 });
	}

	const success = server.upgrade(request, { data: { uuid } });
	if (success) return undefined;

	return new Response('WebSocket upgrade failed', { status: 400 });
}

async function handleMCP(request: Request, server: Bun.Server<{ uuid: string }>) {
	const uuid = request.params.uuid;

	// GET: open a persistent SSE stream for server-to-client messages
	// Per spec: server MAY send JSON-RPC requests and notifications on this stream
	// MUST NOT send responses (unless resuming)
	if (request.method === 'GET') {
		if (!request.headers.get('accept')?.includes('text/event-stream')) {
			return new Response('Not Acceptable', { status: 406 });
		}

		const session = sessions.get(uuid);
		if (!session) {
			return new Response('No active session', { status: 404 });
		}

		const { authToken } = session;
		const authHeader = request.headers.get('authorization');
		if (authToken !== '' && authHeader !== `Bearer ${authToken}`) {
			return new Response('Unauthorized', { status: 401 });
		}

		let controller: ReadableStreamDefaultController<string>;

		const stream = new ReadableStream<string>({
			start(c) {
				controller = c;
				session.sseStreams.add(controller);

				// Per spec: prime the client with an event ID so it can reconnect with Last-Event-ID
				const eventId = `${uuid}-${Date.now()}`;
				controller.enqueue(`id: ${eventId}\n: keep-alive\n\n`);
			},
			cancel() {
				session.sseStreams.delete(controller);
			}
		});

		return new Response(stream, {
			headers: {
				'Content-Type': 'text/event-stream',
				'Cache-Control': 'no-cache',
				'Connection': 'keep-alive',
				'Mcp-Session-Id': uuid,
			}
		});
	}

	// DELETE: explicit session termination per spec
	if (request.method === 'DELETE') {
		const session = sessions.get(uuid);
		if (!session) {
			return new Response('No active session', { status: 404 });
		}
		// Close all open SSE streams
		for (const ctrl of session.sseStreams) {
			try { ctrl.close(); } catch { /* already closed */ }
		}
		sessions.delete(uuid);
		return new Response(null, { status: 200 });
	}

	// POST: client sending a JSON-RPC message
	const session = sessions.get(uuid);

	if (!session) {
		return new Response('No active session', { status: 404 });
	}

	const { authToken } = session;
	const authHeader = request.headers.get('authorization');
	if (authToken !== '' && authHeader !== `Bearer ${authToken}`) {
		return new Response('Unauthorized', { status: 401 });
	}

	const body = await request.text();
	const requestId = getNextRequestId(session);

	if (session.pendingRequests.has(requestId)) {
		return new Response('Too many concurrent requests', { status: 429 });
	}

	const replyPromise = new Promise<{ status: number; content: string }>((resolve) => {
		session.pendingRequests.set(requestId, resolve);
	});

	server.publish(uuid, requestId + body);

	const { status, content } = await replyPromise;
	return new Response(content || null, {
		status: Number.isNaN(status) ? 200 : status,
		headers: {
			'Content-Type': 'application/json',
			'Mcp-Session-Id': uuid,
		}
	});
}

const server = Bun.serve<{ uuid: string }>({
	routes: {
		'/mcp/:uuid': handleMCP,
		'/mcp/ws/:uuid': handleWS,
		'/anthropic': handleAnthropic,
		'/gemini': handleGemini,
		'/gemini/mcp': handleGeminiMCP
	},
	websocket: {
		open(ws) {
			console.log(`WebSocket opened for session ${ws.data.uuid}`);
			ws.subscribe(ws.data.uuid);
		},
		message(ws, message) {
			const { uuid } = ws.data;
			const session = sessions.get(uuid);

			if (!session) {
				// First message must be auth
				if (typeof message === 'string') {
					try {
						const data = JSON.parse(message);
						sessions.set(uuid, {
							authToken: data.token ?? '',
							seq: 0,
							pendingRequests: new Map(),
							sseStreams: new Set(),
						});
					} catch {
						ws.close(1008, 'Invalid auth payload');
					}
				}
				return;
			}

			if (typeof message === 'string') {
				const requestId = message.substring(0, 3);
				const status = Number.parseInt(message.substring(3, 6), 10);
				const content = message.substring(6);
				const resolve = session.pendingRequests.get(requestId);
				if (resolve) {
					session.pendingRequests.delete(requestId);
					resolve({ status, content });
				}
			}
		},
		close(ws) {
			sessions.delete(ws.data.uuid);
			ws.unsubscribe(ws.data.uuid);
		}
	}
});

console.log(`Listening on ${server.hostname}:${server.port}`);
