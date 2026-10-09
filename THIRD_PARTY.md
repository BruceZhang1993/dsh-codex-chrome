# Third-party notices

`dsh-codex-chrome` ships **no** OpenAI code. It adapts the user's locally
installed copy of the OpenAI Codex `chrome@openai-bundled` plugin at runtime by:

- importing that installation's `scripts/browser-client.mjs`, and
- letting the Codex `node_repl` host load that installation's
  `scripts/browser-service.mjs` as its trusted `browser` service.

Those files are proprietary to OpenAI, are covered by the licence that came with
the ChatGPT/Codex desktop application, and are **not** redistributed here.

The `control-chrome` skill document is an independent DSH rewrite of the workflow
described by the upstream Codex skill; it was written for this bundle and does not
copy upstream text verbatim.

This package's own source is MIT licensed; see `LICENSE`.
