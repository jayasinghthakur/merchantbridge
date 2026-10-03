/** Integration snippets shown on /docs. Pure string builders so they can be unit-tested. */

export const KEY_PLACEHOLDER = 'mb_live_YOUR_KEY';
export const SAMPLE_QUESTION = 'Is CHAI-250 in stock in Bengaluru, and at what price?';

export function claudeCodeDemo(demoUrl: string): string {
  return `claude mcp add --transport http mb-demo ${demoUrl}`;
}

export function claudeCodeLive(mcpUrl: string, key = KEY_PLACEHOLDER): string {
  return `claude mcp add --transport http merchantbridge ${mcpUrl} --header "Authorization: Bearer ${key}"`;
}

export function agentSdkTs(mcpUrl: string): string {
  return `import { query } from '@anthropic-ai/claude-agent-sdk';

for await (const message of query({
  prompt: '${SAMPLE_QUESTION}',
  options: {
    mcpServers: {
      merchantbridge: {
        type: 'http',
        url: '${mcpUrl}',
        headers: { Authorization: \`Bearer \${process.env.MERCHANTBRIDGE_KEY}\` },
      },
    },
    allowedTools: ['mcp__merchantbridge__*'],
  },
})) {
  if (message.type === 'result') console.log(message);
}`;
}

export function agentSdkPython(mcpUrl: string): string {
  return `import asyncio
import os

from claude_agent_sdk import ClaudeAgentOptions, query

options = ClaudeAgentOptions(
    mcp_servers={
        "merchantbridge": {
            "type": "http",
            "url": "${mcpUrl}",
            "headers": {"Authorization": f"Bearer {os.environ['MERCHANTBRIDGE_KEY']}"},
        }
    },
    allowed_tools=["mcp__merchantbridge__*"],
)


async def main() -> None:
    async for message in query(prompt="${SAMPLE_QUESTION}", options=options):
        print(message)


asyncio.run(main())`;
}

export function messagesApiCurl(mcpUrl: string, model: string, key = KEY_PLACEHOLDER): string {
  return `curl https://api.anthropic.com/v1/messages \\
  -H "x-api-key: $ANTHROPIC_API_KEY" \\
  -H "anthropic-version: 2023-06-01" \\
  -H "anthropic-beta: mcp-client-2025-11-20" \\
  -H "content-type: application/json" \\
  -d '{
    "model": "${model}",
    "max_tokens": 1024,
    "messages": [{"role": "user", "content": "${SAMPLE_QUESTION}"}],
    "mcp_servers": [{
      "type": "url",
      "url": "${mcpUrl}",
      "name": "merchantbridge",
      "authorization_token": "${key}"
    }],
    "tools": [{"type": "mcp_toolset", "mcp_server_name": "merchantbridge"}]
  }'`;
}
