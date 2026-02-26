import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic({
  apiKey: process.env.API_KEY || "", defaultHeaders: {
    "anthropic-version": "2023-06-01",
    "anthropic-beta": "mcp-client-2025-11-20"
  }
});

export async function handleLLM(request: Request, server: Bun.Server<{ uuid: string }>) {
  const referer = request.headers.get('referer');
  if (referer) {
    const url = new URL(referer);
    const hostname = url.hostname;
    if (
      hostname === 'localhost' ||
      hostname === '127.0.0.1' ||
      hostname.startsWith('192.168.') ||
      hostname.startsWith('10.') ||
      hostname.startsWith('172.16.') ||
      hostname.startsWith('172.31.')
    ) {
    } else {
      return new Response(JSON.stringify({ error: 'Forbidden' }), { status: 403 });
    }
  }

  const message = await request.json();

  const stream = new ReadableStream({
    async start(controller) {
      try {
        const anthropicStream = await client.messages.stream(message);

        for await (const chunk of anthropicStream) {
          const data = JSON.stringify(chunk);
          controller.enqueue(new TextEncoder().encode(`data: ${data}\n\n`));
        }

        controller.enqueue(new TextEncoder().encode(`data: [DONE]\n\n`));
        controller.close();
      } catch (error) {
        controller.error(error);
      }
    }
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive"
    }
  });
}