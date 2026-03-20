import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';

export class FrontendMCPTransport implements Transport {
	private socket: WebSocket;
	private authorizationToken: string;
	private requestMap = new Map<string | number, string>();
	public onclose?: () => void;
	public onerror?: (error: Error) => void;
	public onmessage?: (message: JSONRPCMessage) => void;

	constructor(webSocket: WebSocket | string, authorizationToken: string) {
		this.authorizationToken = authorizationToken;
		if (typeof webSocket === 'string') {
			this.socket = new WebSocket(webSocket);
		} else {
			this.socket = webSocket;
		}
	}

	async start(): Promise<void> {
		this.socket.onmessage = this.handleSocketMessage.bind(this);
		this.socket.onclose = () => {
			this.onclose?.();
			this.reconnect();
		};
		this.socket.onerror = (err) => {
			this.onerror?.(new Error('WebSocket error'));
			this.reconnect();
		};

		const sendAuth = () => {
			this.socket.send(JSON.stringify({ type: 'auth', token: this.authorizationToken }));
		};

		if (this.socket.readyState === WebSocket.OPEN) {
			sendAuth();
		} else {
			this.socket.addEventListener('open', sendAuth);
		}
	}

	async close(): Promise<void> {
		this.socket.close();
	}

	async send(message: JSONRPCMessage | null): Promise<void> {
		if (message === null) {
			return;
		}
		let requestId = '000';
		if ('id' in message && message.id !== undefined) {
			const storedId = this.requestMap.get(message.id);
			if (storedId) {
				requestId = storedId;
				this.requestMap.delete(message.id);
			}
		}
		this.socket.send(`${requestId}200${JSON.stringify(message)}`);
	}

	// Not used yet
	private sendChunk(mcpId: string | number, message: JSONRPCMessage): void {
		const requestId = this.requestMap.get(mcpId);
		if (!requestId) {
			console.warn('sendChunk: no requestId for mcpId', mcpId);
			return;
		}
		this.socket.send(`${requestId}CHK${JSON.stringify(message)}`);
	}

	private handleSocketMessage(event: MessageEvent): void {
		const dataStr = event.data as string;
		const requestId = dataStr.substring(0, 3);
		const payload = dataStr.substring(3);

		const message = JSON.parse(payload) as JSONRPCMessage;
		if (!('id' in message) || message.id === undefined) {
			this.socket.send(`${requestId}202`);
		} else {
			this.requestMap.set(message.id, requestId);
		}
		this.onmessage?.(message);
	}

	private reconnect(): void {
		const oldSocket = this.socket;
		oldSocket.onclose = null;
		oldSocket.onerror = null;
		oldSocket.onmessage = null;
		oldSocket.close();
		const newSocket = new WebSocket(this.socket.url);
		this.socket = newSocket;
		this.start();
	}
}
