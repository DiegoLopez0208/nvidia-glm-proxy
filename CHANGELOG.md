# Changelog

All notable changes to this project will be documented in this file.

## [1.0.1] - 2025-05-29

### Fixed

- **401 Unauthorized**: `buildProxyHeaders` now always replaces the client's `Authorization` header with the real NVIDIA API key from `.env`, even when the client sends a dummy key like `sk-proxy`. Previously it only injected the key when no `Authorization` header was present, causing NVIDIA to reject dummy keys with 401.

- **ETIMEDOUT / Bad Gateway**: Switched from `https.request` (HTTP/1.1) to `http2` (native Node.js HTTP/2 module) for upstream connections to `integrate.api.nvidia.com`. NVIDIA's API requires HTTP/2 for chat/completions — HTTP/1.1 connections would silently timeout. Added H2 session pooling with auto-reconnect on error/goaway/close.

- **Windows `install.ps1` script directory detection**: Replaced `$MyInvocation.MyCommand.Path` with `$PSScriptRoot` + fallbacks. Added `Set-Location $ScriptDir` to fix working directory when launched as Administrator (which defaults to `C:\Windows\System32`).

- **Windows `uninstall.ps1` script directory detection**: Same fix as `install.ps1`.

### Added

- **Windows support**: `install.ps1` (PowerShell installer with pm2), `uninstall.ps1`, `ecosystem.config.js` (pm2 process config).
- **Changelog**: This file.

### Changed

- Startup log now shows `(HTTP/2)` after the upstream host.
- Proxy returns `504 Gateway Timeout` instead of `502 Bad Gateway` on upstream timeout.

## [2.0.0] - 2025-05-28

### Added

- Initial release: env-based config, zero dependencies.
- `buildProxyHeaders`: injects default API key from env when client doesn't provide one.
- `patchToolCalls`: converts numeric `id` to `call_<number>` string format.
- `patchToolCalls`: generates stable `call_<uuid>` for missing tool call IDs.
- `inferFunctionName`: infers missing `function.name` from tool definitions, user message, and `tool_choice`.
- ID stabilization across SSE chunks using `toolCallIdMap`.
- `install.sh`: systemd user service installer for Linux.
- `.env` / `.env.example` configuration.
- `nvidia-glm-proxy.service`: systemd unit file.
