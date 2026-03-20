import { handleGeminiMCP } from './gemini';
import { handleGemini, handleLLM as handleAnthropic } from './llm';

const REPLY_TIMEOUT_MS = 240_000;

interface SinglePending {
	kind: 'single';
	resolve: (result: { status: number; content: string }) => void;
	timer: ReturnType<typeof setTimeout>;
}

interface StreamPending {
	kind: 'stream';
	controller: ReadableStreamDefaultController<string>;
	timer: ReturnType<typeof setTimeout>;
}

type PendingRequest = SinglePending | StreamPending;

interface Session {
	authToken: string;
	seq: number;
	pendingRequests: Map<string, PendingRequest>;
	sseStreams: Set<ReadableStreamDefaultController<string>>;
}

// Single source of truth per session
const sessions = new Map<string, Session>();

function getNextRequestId(session: Session): string {
	session.seq = (session.seq + 1) & 0xfff;
	return session.seq.toString(16).padStart(3, '0');
}

// Scan up to 4096 slots for a free request ID to avoid collisions on wrap-around.
function allocRequestId(session: Session): string | null {
	for (let i = 0; i <= 0xfff; i++) {
		const id = getNextRequestId(session);
		if (!session.pendingRequests.has(id)) return id;
	}
	return null;
}

function isAuthorized(session: Session, request: Request): boolean {
	if (session.authToken === '') return true;
	const authHeader = request.headers.get('authorization');
	return authHeader?.startsWith('Bearer ') === true &&
		authHeader.slice('Bearer '.length) === session.authToken;
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

	if (request.method === 'GET') {
		if (!request.headers.get('accept')?.includes('text/event-stream')) {
			return new Response('Not Acceptable', { status: 406 });
		}

		const session = sessions.get(uuid);
		if (!session) return new Response('No active session', { status: 404 });
		if (!isAuthorized(session, request)) return new Response('Unauthorized', { status: 401 });

		let controller: ReadableStreamDefaultController<string>;

		const stream = new ReadableStream<string>({
			start(c) {
				controller = c;
				session.sseStreams.add(controller);
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

	if (request.method === 'DELETE') {
		const session = sessions.get(uuid);
		if (!session) return new Response('No active session', { status: 404 });
		for (const ctrl of session.sseStreams) {
			try { ctrl.close(); } catch { /* already closed */ }
		}
		sessions.delete(uuid);
		return new Response(null, { status: 200 });
	}

	// POST
	const session = sessions.get(uuid);
	if (!session) return new Response('No active session', { status: 404 });
	if (!isAuthorized(session, request)) return new Response('Unauthorized', { status: 401 });

	const wantsSSE = request.headers.get('accept')?.includes('text/event-stream') ?? false;
	const body = await request.text();

	const requestId = allocRequestId(session);
	if (requestId === null) {
		return new Response('Too many concurrent requests', { status: 429 });
	}

	if (wantsSSE) {
		let streamController: ReadableStreamDefaultController<string>;

		const stream = new ReadableStream<string>({
			start(c) {
				streamController = c;
				const timer = setTimeout(() => {
					session.pendingRequests.delete(requestId);
					try { streamController.close(); } catch { /* already closed */ }
				}, REPLY_TIMEOUT_MS);

				session.pendingRequests.set(requestId, {
					kind: 'stream',
					controller: streamController,
					timer,
				});

				server.publish(uuid, requestId + body);
			},
			cancel() {
				const pending = session.pendingRequests.get(requestId);
				if (pending) {
					clearTimeout(pending.timer);
					session.pendingRequests.delete(requestId);
				}
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
	} else {
		const replyPromise = new Promise<{ status: number; content: string }>((resolve, reject) => {
			const timer = setTimeout(() => {
				session.pendingRequests.delete(requestId);
				reject(new Error('timeout'));
			}, REPLY_TIMEOUT_MS);

			session.pendingRequests.set(requestId, { kind: 'single', resolve, timer });
		});

		server.publish(uuid, requestId + body);

		try {
			const { status, content } = await replyPromise;
			return new Response(content || null, {
				status: Number.isNaN(status) ? 200 : status,
				headers: {
					'Content-Type': 'application/json',
					'Mcp-Session-Id': uuid,
				}
			});
		} catch {
			return new Response('Timed out waiting for WebSocket reply', { status: 504 });
		}
	}
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

			// Use a per-connection authenticated flag stored on ws.data to avoid
			// the TOCTOU race of checking the sessions map across rapid messages.
			if (!(ws.data as any).authenticated) {
				if (typeof message === 'string') {
					try {
						const data = JSON.parse(message);
						sessions.set(uuid, {
							authToken: data.token ?? '',
							seq: 0,
							pendingRequests: new Map(),
							sseStreams: new Set(),
						});
						(ws.data as any).authenticated = true;
					} catch {
						ws.close(1008, 'Invalid auth payload');
					}
				}
				return;
			}

			if (typeof message !== 'string') return;

			const session = sessions.get(uuid);
			if (!session) return;

			const requestId = message.substring(0, 3);
			const statusStr = message.substring(3, 6);
			const content = message.substring(6);
			const pending = session.pendingRequests.get(requestId);
			if (!pending) return;

			if (statusStr === 'CHK') {
				// Streaming chunk — forward to SSE stream without removing pending
				if (pending.kind === 'stream') {
					const eventId = `${requestId}-${Date.now()}`;
					try {
						pending.controller.enqueue(`id: ${eventId}\ndata: ${content}\n\n`);
					} catch { /* client disconnected */ }
				}
				return;
			}

			const status = Number.parseInt(statusStr, 10);
			if (Number.isNaN(status)) {
				// Unrecognised status token — unblock caller with 502
				console.error(`[ws ${uuid}] unrecognised status "${statusStr}" for request ${requestId}; unblocking caller`);
				clearTimeout(pending.timer);
				session.pendingRequests.delete(requestId);
				if (pending.kind === 'single') {
					pending.resolve({ status: 502, content: 'bad gateway: unrecognised WS status token' });
				} else {
					try {
						pending.controller.enqueue(`data: bad gateway: unrecognised WS status token\n\n`);
						pending.controller.close();
					} catch { /* already closed */ }
				}
				return;
			}

			clearTimeout(pending.timer);
			session.pendingRequests.delete(requestId);

			if (pending.kind === 'single') {
				pending.resolve({ status, content });
			} else {
				const eventId = `${requestId}-final`;
				try {
					pending.controller.enqueue(`id: ${eventId}\ndata: ${content}\n\n`);
					pending.controller.close();
				} catch { /* already closed */ }
			}
		},
		close(ws) {
			sessions.delete(ws.data.uuid);
			ws.unsubscribe(ws.data.uuid);
		}
	}
});

console.log(`Listening on ${server.hostname}:${server.port}`);
