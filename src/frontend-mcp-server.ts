import { type ServerOptions } from '@modelcontextprotocol/sdk/server/index.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { type Implementation } from '@modelcontextprotocol/sdk/types.js';
import { FrontendMCPTransport } from './frontend-mcp-transport.js';

type FrontendMCPServerConfig = {
	mcpServerUrl?: string;
	websocketUrl?: string;
	uuid?: string;
	authorizationToken?: string;
};

export class FrontendMCPServer extends McpServer {
	readonly authorizationToken: string;
	readonly url: string;
	private uuid: string;
	private websocketUrl: string;

	constructor(
		serverInfo: Implementation & { frontendMCP?: FrontendMCPServerConfig },
		options?: ServerOptions
	) {
		super(serverInfo, options);

		const frontendMCPConfig =
			serverInfo.frontendMCP === undefined
				? {
					mcpServerUrl: 'https://mcp.frontendmcp.com/mcp',
					websocketUrl: 'wss://mcp.frontendmcp.com/mcp'
				}
				: serverInfo.frontendMCP;

		frontendMCPConfig.mcpServerUrl =
			frontendMCPConfig.mcpServerUrl ?? 'https://mcp.frontendmcp.com/mcp';
		frontendMCPConfig.websocketUrl = frontendMCPConfig.websocketUrl ?? 'wss://mcp.frontendmcp.com/mcp';

		frontendMCPConfig.mcpServerUrl = frontendMCPConfig.mcpServerUrl.replace(/\/$/, '');
		frontendMCPConfig.websocketUrl = frontendMCPConfig.websocketUrl.replace(/\/$/, '');

		frontendMCPConfig.uuid = frontendMCPConfig.uuid ?? crypto.randomUUID();
		frontendMCPConfig.authorizationToken =
			frontendMCPConfig.authorizationToken ?? crypto.randomUUID();

		this.uuid = frontendMCPConfig.uuid;
		this.authorizationToken = frontendMCPConfig.authorizationToken;
		this.url = `${frontendMCPConfig.mcpServerUrl}/${this.uuid}`;
		this.websocketUrl = `${frontendMCPConfig.websocketUrl}/${this.uuid}`;
	}

	public override async connect() {
		const socket = new WebSocket(this.websocketUrl);
		const transport = new FrontendMCPTransport(socket, this.authorizationToken);
		super.connect(transport);
	}
}
