# DeepSeek LLM Chat CLI Design

## Context

The current project is a minimal Node.js package with only `package.json`.
The goal is to add a TypeScript command-line chat program that talks to
DeepSeek through the OpenAI SDK and DeepSeek's OpenAI-compatible API.

DeepSeek's current API documentation lists `https://api.deepseek.com` as the
OpenAI-compatible base URL and `deepseek-v4-flash` as a supported model.

## Goals

- Provide an interactive CLI chat loop for LLM conversation.
- Use the official `openai` npm package.
- Configure the OpenAI SDK client for DeepSeek.
- Read the API key from `DEEPSEEK_API_KEY`.
- Default to `deepseek-v4-flash`.
- Stream assistant output as it is generated.
- Keep conversation history in memory for the current process only.

## Non-Goals

- No persistent chat history.
- No npm package publishing setup.
- No tool calling, file context injection, or agent framework.
- No GUI or web interface.

## User Experience

The user starts the CLI with:

```bash
pnpm chat
```

At startup, the program checks for `DEEPSEEK_API_KEY`. If the variable is
missing, it prints a clear setup message and exits with a non-zero status.

When configured, the CLI enters a prompt loop:

```text
you>
```

The user types a message and presses Enter. The assistant response streams to
stdout as tokens arrive. After each response, the CLI prints a newline and
shows the next prompt. Empty input is ignored. The commands `exit` and `quit`
end the session. `Ctrl+C` also exits cleanly.

## Configuration

Environment variables:

- `DEEPSEEK_API_KEY`: required API key.
- `DEEPSEEK_MODEL`: optional model override, default `deepseek-v4-flash`.
- `DEEPSEEK_BASE_URL`: optional base URL override, default
  `https://api.deepseek.com`.

`DEEPSEEK_MODEL` and `DEEPSEEK_BASE_URL` are optional to keep the default path
simple while allowing easy testing against compatible endpoints.

## Technical Design

Use TypeScript with a small file layout:

```text
package.json
tsconfig.json
src/
  index.ts
```

Dependencies:

- `openai` for API access.
- `tsx` for running TypeScript directly during development.
- `typescript` for type checking.

Package scripts:

```json
{
  "chat": "tsx src/index.ts",
  "typecheck": "tsc --noEmit"
}
```

`src/index.ts` will contain the CLI, with clear internal function boundaries:

- `createClient()`: validates environment and returns an OpenAI SDK client.
- `runChatLoop()`: owns readline setup, prompts, and exit handling.
- `sendMessage()`: sends the current message history with streaming enabled.
- `extractDelta()`: extracts streamed assistant text from each chunk.

This keeps the first implementation compact while leaving natural seams for
future module extraction.

## Data Flow

1. Start process with `pnpm chat`.
2. Read environment variables.
3. Create `OpenAI` client with `apiKey` and `baseURL`.
4. Initialize an in-memory `messages` array.
5. For each non-empty user input:
   - Append `{ role: "user", content: input }`.
   - Call `client.chat.completions.create()` with `stream: true`.
   - Print each streamed text delta to stdout.
   - Accumulate the full assistant response.
   - Append `{ role: "assistant", content: response }` after completion.

If a streaming call fails before completion, the partial assistant response is
not appended to history.

## Error Handling

- Missing `DEEPSEEK_API_KEY`: print a direct setup message and exit.
- API request failure: print a concise error and continue the prompt loop.
- Empty input: ignore and prompt again.
- `exit`, `quit`, or `Ctrl+C`: close readline and terminate cleanly.

## Verification

Run these checks after implementation:

```bash
pnpm install
pnpm typecheck
```

Manual checks:

- Without `DEEPSEEK_API_KEY`, `pnpm chat` prints the missing-key error.
- With `DEEPSEEK_API_KEY`, `pnpm chat` starts an interactive session.
- A simple prompt returns a streamed response.
- A second prompt includes prior conversation context.
- `exit`, `quit`, and `Ctrl+C` terminate cleanly.

## References

- DeepSeek API Docs: https://api-docs.deepseek.com/
- DeepSeek Models and Pricing: https://api-docs.deepseek.com/quick_start/pricing
