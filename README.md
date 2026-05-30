# nvidia-glm-proxy

A lightweight reverse proxy for the NVIDIA NIM API that fixes GLM-5.1 tool_call streaming bugs and **auto-routes vision requests to Llama 3.2 90B Vision**. Zero dependencies.

## Problem

NVIDIA's GLM-5.1 model via NIM has several bugs when streaming tool calls:

- **Numeric `id`** — tool call IDs are returned as numbers instead of strings (e.g. `"id": 1` instead of `"id": "call_abc123"`)
- **Missing `id`** — tool call IDs are sometimes omitted entirely
- **Missing `function.name`** — the function name inside tool calls is sometimes `null` or missing
- **ID instability** — the same tool call index gets different IDs across SSE chunks, breaking accumulation
- **401 Unauthorized** — clients sending dummy API keys (like `sk-proxy`) get rejected by NVIDIA
- **ETIMEDOUT** — HTTP/1.1 connections to NVIDIA NIM API timeout intermittently

## Solution

`nvidia-glm-proxy` sits between your client and `integrate.api.nvidia.com`, patching responses in real-time:

| Bug | Fix |
|---|---|
| Numeric `id` | Converts to `call_<number>` string format |
| Missing `id` | Generates a stable `call_<uuid>` |
| Missing `function.name` | Infers from tool definitions + user message + `tool_choice` |
| Unstable IDs across chunks | Stabilizes IDs per `index` using a chunk map |
| 401 with dummy API keys | Always replaces client `Authorization` header with real key from `.env` |
| ETIMEDOUT / Bad Gateway | Uses HTTP/2 with session pooling for upstream connection |

## Install

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
| `NVIDIA_API_KEY` | _(empty)_ | Your NVIDIA NIM API key. If set, the proxy **always** overrides the client's `Authorization` header with this key |
| `NVIDIA_NIM_HOST` | `integrate.api.nvidia.com` | Upstream NVIDIA NIM host |
| `NVIDIA_NIM_PORT` | `443` | Upstream port |
| `PROXY_PORT` | `9999` | Local port the proxy listens on |
| `UPSTREAM_TIMEOUT` | `180000` | Upstream request timeout in ms (180s default for vision model) |
| `BIND_ADDRESS` | `127.0.0.1` | Address to bind to |
| `VISION_MODEL` | `meta/llama-3.2-90b-vision-instruct` | Model to route vision requests to (when image_url detected) |

## Usage

### Linux

Start the proxy:

```bash
node proxy.js
```

Or install as a systemd user service:

```bash
bash install.sh
```

Check logs:

```bash
journalctl --user -u nvidia-glm-proxy -f
```

### Windows

#### Prerequisites

- [Node.js](https://nodejs.org/) v18+

#### Quick start

```powershell
# Run directly
node proxy.js
```

#### Install as a service (auto-start on boot)

1. Run the installer as Administrator:

```powershell
.\install.ps1
```

The installer will:
- Check for Node.js
- Create `.env` from `.env.example` if missing
- Install [pm2](https://pm2.keymetrics.io/) globally
- Start the proxy with pm2
- Optionally register as a Windows Service via `pm2-windows-service`

2. To install as a Windows Service (starts on boot):

```powershell
npm install -g pm2-windows-service
pm2-service-install
```

#### Useful pm2 commands

```powershell
pm2 status                     # list running processes
pm2 logs nvidia-glm-proxy      # view logs
pm2 restart nvidia-glm-proxy   # restart proxy
pm2 stop nvidia-glm-proxy      # stop proxy
```

#### Uninstall

```powershell
.\uninstall.ps1
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
        "z-ai/glm-5.1": { "name": "z-ai/glm-5.1" },
        "meta/llama-3.2-90b-vision-instruct": { "name": "meta/llama-3.2-90b-vision-instruct" }
      }
    }
  }
}
```

The `apiKey` value doesn't matter if `NVIDIA_API_KEY` is set in `.env` — the proxy will replace it with the real key automatically.

## Vision Auto-Routing

When a request contains `image_url` in any message's content array, the proxy automatically rewrites the `model` field to `VISION_MODEL` (default: `meta/llama-3.2-90b-vision-instruct`). This enables vision capabilities for any client — including MCP tools — without code changes.

### How it works

1. Request arrives at `/v1/chat/completions`
2. Proxy scans all `messages[*].content` for `type: "image_url"`
3. If found: `body.model = VISION_MODEL` (logged as `[VISION] detected image_url -> routing to meta/llama-3.2-90b-vision-instruct`)
4. Request is forwarded to NVIDIA NIM with the vision model
5. Response patches (ID fixes, name inference) are applied as usual

### Example

```bash
curl -X POST http://127.0.0.1:9999/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "z-ai/glm-5.1",
    "messages": [{
      "role": "user",
      "content": [
        {"type": "image_url", "image_url": {"url": "data:image/png;base64,..."}},
        {"type": "text", "text": "What do you see?"}
      ]
    }],
    "max_tokens": 200
  }'
# Model is auto-routed to meta/llama-3.2-90b-vision-instruct
```

Text-only requests continue to use the original model (e.g. GLM-5.1).

### Health check

```bash
curl http://127.0.0.1:9999/health
```

Windows (PowerShell):

```powershell
Invoke-WebRequest http://127.0.0.1:9999/health
```

## How function.name inference works

When GLM-5.1 omits `function.name` from a tool call, the proxy tries to infer it:

1. **`tool_choice`** — if the request forces a specific function, use that
2. **User message match** — if the user message contains a no-param tool name, use that
3. **Keyword scoring** — match user message words against tool descriptions and name parts
4. **Single tool fallback** — if only one tool is available, use it
5. **Parameter signature matching** — match argument keys against tool parameter schemas
6. **Fallback** — `"unknown"` if nothing matches

## Changelog

### v1.1.0

- **Vision auto-routing**: requests with `image_url` are automatically routed to `VISION_MODEL` (default: `meta/llama-3.2-90b-vision-instruct`). No client changes needed.
- **`VISION_MODEL` env var**: configure the vision model to route to
- **Health endpoint**: now returns `visionModel` field
- **Windows `.env` compatibility**: CRLF line ending support (`\r?\n` splitting) and UTF-8 BOM stripping
- **`UPSTREAM_TIMEOUT` default**: 120s → 180s (vision inference is slower)

### v1.0.3

- **Fix Windows install.ps1 crash**: `pm2 delete` no longer crashes on first install — checks if process exists before deleting

### v1.0.1

- **Fix 401 Unauthorized**: always replace client `Authorization` header with real NVIDIA API key from `.env`, preventing auth errors when clients send dummy keys like `sk-proxy`
- **Fix ETIMEDOUT / Bad Gateway**: switch from HTTP/1.1 (`https`) to HTTP/2 (`http2`) for upstream connection to NVIDIA NIM API, with H2 session pooling and auto-reconnect
- Windows support: `install.ps1`, `uninstall.ps1`, `ecosystem.config.js` for pm2

### v2.0.0

- Initial release: env-based config, zero dependencies, function.name inference, id stabilization

## License

MIT
