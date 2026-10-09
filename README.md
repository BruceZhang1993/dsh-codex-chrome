# dsh-codex-chrome

[![CI](https://github.com/BruceZhang1993/dsh-codex-chrome/actions/workflows/ci.yml/badge.svg?branch=master)](https://github.com/BruceZhang1993/dsh-codex-chrome/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](package.json)
[![Version](https://img.shields.io/badge/version-0.1.0-blue.svg)](package.json)
[![DeepSeek Harness plugin](https://img.shields.io/badge/DeepSeek%20Harness-plugin-4B6BFB.svg)](https://github.com/deepseek-ai/deepseek-harness)
[![MCP](https://img.shields.io/badge/MCP-stdio-6E56CF.svg)](https://modelcontextprotocol.io)
[![Codex plugin](https://img.shields.io/badge/Codex-chrome%40openai--bundled-10A37F.svg)](https://github.com/openai/codex)

**English** · [简体中文](README.zh-CN.md)

**Control your own Chrome from [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)** by
migrating OpenAI Codex's `chrome@openai-bundled` plugin into DSH. The agent gets a set of native
`mcp__chrome__*` tools and can reuse the browser state you already have — open tabs, cookies,
logged-in sessions — to navigate, read pages, click, type and take screenshots.

![DSH capturing a page from the user's Chrome via chrome_observe](docs/screenshot-chrome.jpg)

Above: a DSH session calling `chrome_observe { mode: "screenshot", fullPage: true }` and getting a
capture of the page open in the user's own Chrome.

## What the Codex "plugin" actually is

It is enabled in `~/.codex/config.toml` as:

```toml
[plugins."chrome@openai-bundled"]
enabled = true
```

But it is **not an MCP server**. It is three things:

| Part | Location | Role |
|---|---|---|
| Skill | `~/.codex/plugins/cache/openai-bundled/chrome/<ver>/skills/control-chrome/SKILL.md` | Tells the model to select a browser, observe with `ax.write()`, then act |
| Hooks | `plugin.json` → `Stop` / `Interrupt` / `SubagentStop` | Call the `node_repl` tool `turn_ended` each turn to release browser control |
| Runtime | `scripts/browser-client.mjs` + `scripts/browser-service.mjs` | The actual browser control, hosted by Codex's `node_repl` MCP server as a **trusted service** |

`browser-client.mjs` drives the work through `globalThis.nodeRepl.rpc("browser", …)`, and that service
**only** runs inside the Codex `node_repl` host: it depends on privileged capabilities that exist
nowhere else (`nativePipe`, `addTurnEndedHandler`, `createElicitation`, host-injected turn metadata).
This migration therefore **does not rewrite browser control** — it reuses the vendor runtime exactly as
shipped.

## Why there is an extra bridge process

Every browser call must carry Codex turn metadata:

```json
{ "_meta": { "x-codex-turn-metadata": { "session_id": "…", "turn_id": "…", "call_id": "…" } } }
```

The browser service reads it from `nodeRepl.requestMeta` and hard-fails without it:

```
Missing required Codex turn metadata: session_id, turn_id
```

`@deepseek-ai/dsh-mcp-client` has no per-call `_meta` support — its only call site is
`client.callTool({ name, arguments }, { … })` — so `bin/chrome-mcp.mjs` fronts `node_repl`, injects the
metadata, and republishes the browser API as native DSH tools:

```
DSH ──mcp-client(stdio)──▶ bin/chrome-mcp.mjs ──MCP(stdio) + _meta──▶ Codex node_repl
                                  │                                        │
                                  │                             trusted service browser-service.mjs
                                  │                                        │
                                  └────────── native tools ◀────── ChatGPT browser extension ◀▶ Chrome
```

## Install

```bash
# Install as a bundle into a DSH profile (desktop shown here)
dsh plugin install ~/Projects/dsh-codex-chrome
```

Or do the same thing by hand in `~/.dsh/profiles/<profile>/package.json`:

```json
"dependencies": { "dsh-codex-chrome": "link:/path/to/dsh-codex-chrome" }
"dsh": { "profile": { "bundles": [ "…", "dsh-codex-chrome" ] } }
```

then run `pnpm install` in the profile directory. After a reload the model sees the eleven
`mcp__chrome__*` tools and the `control-chrome` skill.

## Tools

| Tool | Purpose |
|---|---|
| `chrome_status` | List connected browsers, the current binding, and open tabs |
| `chrome_select` | Bind a browser: `chrome` / `edge` / `brave` / `vivaldi` / `opera` / `iab` / `extension` / `default` / `auto` |
| `chrome_tabs` | `list` / `new` / `select` / `close` / `user_tabs` (your own tabs) / `claim` (take one over) |
| `chrome_navigate` | `goto` / `back` / `forward` / `reload` |
| `chrome_observe` | `state` (accessibility tree, preferred) / `dom` / `visible_dom` / `screenshot` / `both` |
| `chrome_act` | `via:"ax"`: click, setValue, typeText, pressKey, paste, scroll, selectText, performSecondaryAction, drag<br>`via:"locator"`: Playwright locator click, fill, press, selectOption, check, waitFor, … |
| `chrome_read` | `innerText` / `textContent` / `allTextContents` / `attribute` / `count` / `isVisible` / `isEnabled` |
| `chrome_evaluate` | Evaluate a read-only expression in the page |
| `chrome_wait` | Wait for `url` / `load` / `timeout` / `selector` |
| `chrome_js` | Escape hatch: run JS inside the Codex runtime with `agent` / `browser` / `tab` in scope |
| `chrome_end_turn` | Release browser control for this turn (Codex's `Stop` hook equivalent) |

The model-facing workflow, documented in the bundled `control-chrome` skill, is
**observe → act → observe**: prefer accessibility element indices over coordinates, and re-derive the
indices after every action.

## Implementation notes

- **State lives on `globalThis`, not in module scope.** Every `js` call in `node_repl` is evaluated in
  a fresh realm that re-evaluates the same `import()`; module-level bindings reset, while `globalThis`
  is shared for the life of the kernel.
- **Screenshots cannot be written to disk.** Once the browser service is active the kernel filesystem
  turns read-only (even `/tmp` and `$CODEX_HOME` return `EROFS`), so images go out through
  `nodeRepl.emitImage`; the bridge spools a copy on the host side.
- **Accessibility indices are bound to the call that produced them.** `chrome_act` re-reads
  `tab.ax.get("state")` before acting so an index returned by `chrome_observe` is usable.
- **The `_meta` injection is the whole point.** Without it every browser call fails.
- **The vendor capture path labels JPEG as PNG.** Both the sandbox and the bridge re-derive the type
  from magic bytes, because DSH rejects an image whose declared type disagrees with its payload.

## Self-checks

```bash
node scripts/check-package.mjs   # static package consistency, no browser needed
node --test                      # 13 tests: unit checks + a real MCP handshake
node scripts/doctor.mjs          # assets, extension, native host, node_repl
node scripts/doctor.mjs --deep   # …plus one real browser round trip
node scripts/smoke.mjs           # end to end: open a tab, observe, screenshot, evaluate, close
```

## Requirements

- Linux (developed and verified on Arch with Chrome 154, on both Wayland and X11).
- The ChatGPT/Codex desktop app must have run at least once, so it materialises
  `~/.codex/plugins/cache/openai-bundled/{chrome,browser}/…` (`scripts/browser-client.mjs`,
  `browser-service.mjs`, `extension-host`).
- The ChatGPT browser extension installed in the target browser, with the
  `com.openai.codexextension` native messaging host registered
  (`~/.config/google-chrome/NativeMessagingHosts/`).
- The target browser running.

Environment overrides:

| Variable | Meaning |
|---|---|
| `CODEX_HOME` | Codex home directory, defaults to `~/.codex` |
| `DSH_CODEX_CHROME_NODE_REPL` | Absolute path to the `node_repl` executable |
| `BROWSER_USE_AVAILABLE_BACKENDS` | Backends handed to `node_repl`, defaults to `chrome,iab,mcpapps` |

## Licence and provenance

This package is MIT licensed. It ships **no** OpenAI code: it calls
`browser-client.mjs` / `browser-service.mjs` from your local Codex installation at runtime, and those
proprietary files are not redistributed. See [THIRD_PARTY.md](THIRD_PARTY.md).
