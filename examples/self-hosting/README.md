# Self-Hosted FrontendMCP Changes

If you want more control over your MCP server's deployment, you can self-host the relay server component of FrontendMCP. This allows you to use a custom domain, implement additional security measures, or modify the relay server's behavior to fit your specific use case.

```javascript
const mcpServer = new FrontendMCPServer({
  version: '1.0', name: 'My MCP Server',
  frontendMCP: {
    mcpServerUrl: 'https://your-custom-domain.com/mcp',
    websocketUrl: 'wss://your-custom-domain.com/mcp/ws',
  }
});
```

To self-host, you'll need to deploy the relay server component of FrontendMCP on your own infrastructure. The source code for a rust and a typescript implementation of the relay server can be found in the [server](../../server/) directory.