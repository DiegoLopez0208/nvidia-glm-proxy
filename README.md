# nvidia-glm-proxy

A lightweight reverse proxy for the NVIDIA NIM API that fixes GLM-5.1 tool_call streaming bugs. Zero dependencies.

## Problem

NVIDIA's GLM-5.1 model via NIM has several bugs when streaming tool calls:

- **Numeric `id`** — tool call IDs are returned as numbers instead of strings (e.g. `"id": 1` instead of `"id": "call_abc123"`)
- **Missing `id`** — tool call IDs are sometimes omitted entirely
- **Missing `function.name`** — the function name inside tool calls is sometimes `null` or missing
- **ID instability** — the same tool call index gets different IDs across SSE chunks, breaking accumulation

These bugs cause OpenAI-compatible clients (like [opencode](https://opencode.ai), Claude, etc.) to crash or misinterpret tool calls.

## Solution

`nvidia-glm-proxy` sits between your client and `integrate.api.nvidia.com`, patching responses in real-time:

| Bug | Fix |
|---|---|
| Numeric `id` | Converts to `call_<number>` string format |
| Missing `id` | Generates a stable `call_<uuid>` |
| Missing `function.name` | Infers from tool definitions + user message + `tool_choice` |
| Unstable IDs across chunks | Stabilizes IDs per `index` using a chunk map |

## Install

### npm (global)

```bash
npm install -g nvidia-glm-proxy
```

### From source

```bash
git clone https://github.com/DiegoLopez0208/nvidia-glm-proxy.git
cd nvidia-glm-proxy
```

## Configuration

Copy `.env.example` to `.env` and fill in your values:

```bash
cp .env.example .env
```

| Variable | Default | Description |
|---|---|---|
| `NVIDIA_API_KEY` | _(empty)_ | Your NVIDIA NIM API key. If set, the proxy injects it as `Authorization: Bearer` when the client doesn't provide one |
| `NVIDIA_NIM_HOST` | `integrate.api.nvidia.com` | Upstream NVIDIA NIM host |
| `NVIDIA_NIM_PORT` | `443` | Upstream port |
| `PROXY_PORT` | `9999` | Local port the proxy listens on |
| `UPSTREAM_TIMEOUT` | `120000` | Upstream request timeout in ms |
| `BIND_ADDRESS` | `127.0.0.1` | Address to bind to |

## Usage

### Start the proxy

```bash
node proxy.js
```

Or with the systemd user service:

```bash
bash install.sh
```

### Update your client config

Point your OpenAI-compatible client at the proxy instead of NVIDIA directly:

```json
{
  "provider": {
    "nvidia-proxy": {
      "npm": "@ai-sdk/openai-compatible",
      "options": {
        "baseURL": "http://127.0.0.1:9999/v1",
        "apiKey": "sk-proxy"
      },
      "models": {
        "z-ai/glm-5.1": { "name": "z-ai/glm-5.1" }
      }
    }
  }
}
```

The `apiKey` value doesn't matter if `NVIDIA_API_KEY` is set in `.env` — the proxy will inject the real key automatically.

### Health check

```bash
curl http://127.0.0.1:9999/health
```

## How function.name inference works

When GLM-5.1 omits `function.name` from a tool call, the proxy tries to infer it:

1. **`tool_choice`** — if the request forces a specific function, use that
2. **User message match** — if the user message contains a no-param tool name, use that
3. **Keyword scoring** — match user message words against tool descriptions and name parts
4. **Single tool fallback** — if only one tool is available, use it
5. **Parameter signature matching** — match argument keys against tool parameter schemas
6. **Fallback** — `"unknown"` if nothing matches

## License

MIT
