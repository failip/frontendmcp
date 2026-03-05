# Anthropic API Example

Anthropic provides a MCP client directly integrated with their API. This allows you to easily connect a FrontendMCP server to an LLM running on the Anthropic platform, without setting up a MCP Client.

For ease of use during development, you can use the "https://mcp.frontendmcp.com/llm" endpoint provided by frontendmcp to connect directly to the Anthropic API. Skipping the need to setup a server endpoint and handle the API key in your backend. This forwards your API key from the frontend to the Anthropic API, so be sure to only use this method in a secure development environment. 

```javascript
	// After setting up your FrontendMCP server and registering your tools, you can connect to the Anthropic API like this:

		const message = {
			model: 'claude-haiku-4-5',
			max_tokens: 1000,
			messages: [
				{
					role: 'user',
					content: prompt,
				}
			],
			mcp_servers: [
				{
					type: 'url',
					url: mcpServer.url,
					name: 'FrontendMCP Server',
					authorization_token: mcpServer.authorizationToken
				}
			],
			tools: [
				{
					type: 'mcp_toolset',
					mcp_server_name: 'FrontendMCP Server'
				}
			]
		};

		// In development, you can connect directly to the frontendmcp relay which forwards to the Anthropic API

		fetch('https://mcp.frontendmcp.com/llm', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'x-api-key': ANTHROPIC_API_KEY
			},
			body: JSON.stringify(message),
		})

		// In production, you should connect directly to the Anthropic API from your backend to keep your API key secure

		fetch('https://api.anthropic.com/v1/messages', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'x-api-key': ANTHROPIC_API_KEY,
				'anthropic-version': '2023-06-01',
				'anthropic-beta': 'mcp-client-2025-11-20'
			},
			body: JSON.stringify(message),
		})

```

## Links

[Anthropic MCP Client documentation](https://platform.claude.com/docs/en/agents-and-tools/mcp-connector).
