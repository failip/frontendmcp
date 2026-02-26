import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";



export class WebsocketRelayTransport implements Transport {
  private socket: WebSocket;
  public onclose?: () => void;
  public onerror?: (error: Error) => void;
  public onmessage?: (message: JSONRPCMessage) => void;

  constructor(socket: WebSocket) {
    this.socket = socket;
  }

  async start(): Promise<void> {
    this.socket.onmessage = this.handleSocketMessage.bind(this);
    this.socket.onclose = () => {
      this.onclose?.();
      this.reconnect();
    };
    this.socket.onerror = (err) => {
      this.onerror?.(new Error("WebSocket error"));
      this.reconnect();
    };
  }

  async close(): Promise<void> {
    this.socket.close();
  }

  async send(message: JSONRPCMessage | null): Promise<void> {
    if (message === null) {
      this.socket.send("202" + JSON.stringify(message));
      return;
    }
    this.socket.send("200" + JSON.stringify(message));
  }

  private handleSocketMessage(event: MessageEvent): void {
    console.debug("Received message:", event.data);
    const message: JSONRPCMessage = JSON.parse(event.data);
    if (message.id === undefined) {
      this.send(null);
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

