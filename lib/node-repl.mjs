/**
 * dsh-codex-chrome — minimal MCP stdio client for the Codex `node_repl` server.
 *
 * `node_repl` speaks plain MCP over stdio with newline-delimited JSON frames, so
 * this client is a few dozen lines instead of a dependency. The only thing it
 * does beyond a generic client is inject the Codex turn metadata that the
 * browser service requires on every `tools/call`.
 *
 * @module dsh-codex-chrome/node-repl
 */

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

/** Protocol revisions this client is willing to negotiate. */
const SUPPORTED_PROTOCOLS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26'];

/** Key the Codex host uses to smuggle session/turn identity through `_meta`. */
export const TURN_METADATA_KEY = 'x-codex-turn-metadata';

/**
 * One live `node_repl` kernel.
 *
 * The kernel is a persistent JavaScript realm: bindings declared by one `js`
 * call survive into the next, which is exactly what the browser session helper
 * relies on for its browser and tab handles.
 */
export class NodeReplBridge {
  #child = null;
  #buffer = '';
  #pending = new Map();
  #nextId = 1;
  #stderr = [];
  #started = null;
  #closed = false;
  #instructions = '';
  #tools = new Map();

  /**
   * @param {{ command: string, args?: string[], env: NodeJS.ProcessEnv, cwd?: string, sessionId?: string }} options
   */
  constructor(options) {
    this.options = options;
    /** Stable for the life of this bridge; the browser service keys sessions by it. */
    this.sessionId = options.sessionId ?? `dsh-chrome-${randomUUID()}`;
    /** Current turn id; bumped by {@link endTurn}. */
    this.turnId = 'turn-1';
  }

  /** Tool list advertised by `node_repl`, populated after {@link start}. */
  get tools() {
    return [...this.#tools.values()];
  }

  /** Server instructions, logged once so setup failures are explainable. */
  get instructions() {
    return this.#instructions;
  }

  /** Recent stderr, used in diagnostics. */
  get stderrTail() {
    return this.#stderr.join('');
  }

  /** Spawn the kernel and complete the MCP handshake. Idempotent. */
  async start() {
    if (this.#started !== null) return this.#started;
    this.#started = (async () => {
      const child = spawn(this.options.command, this.options.args ?? [], {
        env: this.options.env,
        cwd: this.options.cwd ?? undefined,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      this.#child = child;
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk) => this.#onData(chunk));
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk) => {
        this.#stderr.push(chunk);
        if (this.#stderr.length > 40) this.#stderr.shift();
      });
      child.on('exit', (code, signal) => {
        this.#closed = true;
        for (const [, entry] of this.#pending) {
          entry.reject(new Error(`node_repl exited (code=${code ?? 'null'} signal=${signal ?? 'null'})`));
        }
        this.#pending.clear();
      });
      child.on('error', (error) => {
        this.#closed = true;
        for (const [, entry] of this.#pending) entry.reject(error);
        this.#pending.clear();
      });

      const result = await this.#request('initialize', {
        protocolVersion: SUPPORTED_PROTOCOLS[0],
        capabilities: {},
        clientInfo: { name: 'dsh-codex-chrome', version: '0.1.0' },
      }, 60000);
      const negotiated = result?.protocolVersion;
      if (typeof negotiated === 'string' && !SUPPORTED_PROTOCOLS.includes(negotiated)) {
        throw new Error(`node_repl negotiated unsupported MCP protocol ${negotiated}`);
      }
      this.#instructions = typeof result?.instructions === 'string' ? result.instructions : '';
      this.#notify('notifications/initialized', {});

      const list = await this.#request('tools/list', {}, 30000);
      for (const tool of list?.tools ?? []) {
        if (typeof tool?.name === 'string') this.#tools.set(tool.name, tool);
      }
      if (!this.#tools.has('js')) throw new Error('node_repl did not advertise the `js` tool');
      return this;
    })();
    return this.#started;
  }

  /** Route one stdout chunk into whole JSON-RPC frames. */
  #onData(chunk) {
    this.#buffer += chunk;
    let index;
    while ((index = this.#buffer.indexOf('\n')) >= 0) {
      const line = this.#buffer.slice(0, index).trim();
      this.#buffer = this.#buffer.slice(index + 1);
      if (line.length === 0) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      if (message.id === undefined || message.id === null) continue;
      const entry = this.#pending.get(message.id);
      if (entry === undefined) continue;
      this.#pending.delete(message.id);
      clearTimeout(entry.timer);
      if (message.error !== undefined) {
        const error = new Error(message.error?.message ?? 'node_repl request failed');
        error.data = message.error;
        entry.reject(error);
      } else {
        entry.resolve(message.result);
      }
    }
  }

  #send(message) {
    if (this.#child === null || this.#closed) throw new Error('node_repl is not running');
    this.#child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  #notify(method, params) {
    this.#send({ jsonrpc: '2.0', method, params });
  }

  #request(method, params, timeoutMs) {
    const id = this.#nextId;
    this.#nextId += 1;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`node_repl ${method} timed out after ${timeoutMs} ms`));
      }, timeoutMs);
      this.#pending.set(id, { resolve, reject, timer });
      try {
        this.#send({ jsonrpc: '2.0', id, method, params });
      } catch (error) {
        clearTimeout(timer);
        this.#pending.delete(id);
        reject(error);
      }
    });
  }

  /** Turn metadata injected into every tool call; without it the browser service refuses to run. */
  #metadata(callId) {
    return {
      [TURN_METADATA_KEY]: {
        session_id: this.sessionId,
        turn_id: this.turnId,
        call_id: callId,
      },
    };
  }

  /**
   * Call a `node_repl` tool with Codex turn metadata attached.
   *
   * @param {string} name
   * @param {object} args
   * @param {{ timeoutMs?: number }} [options]
   * @returns {Promise<{ content: Array<object>, isError: boolean }>}
   */
  async callTool(name, args, options = {}) {
    await this.start();
    if (!this.#tools.has(name)) throw new Error(`node_repl does not expose the "${name}" tool`);
    const timeoutMs = options.timeoutMs ?? 120000;
    const result = await this.#request('tools/call', {
      name,
      arguments: args,
      _meta: this.#metadata(`call-${this.#nextId}`),
    }, timeoutMs);
    return { content: result?.content ?? [], isError: result?.isError === true };
  }

  /**
   * Run JavaScript in the persistent kernel.
   *
   * @param {string} code
   * @param {{ timeoutMs?: number, title?: string }} [options]
   * @returns {Promise<{ text: string, images: Array<{ data: string, mimeType: string }>, isError: boolean }>}
   */
  async runJs(code, options = {}) {
    const result = await this.callTool('js', {
      code,
      ...(options.title === undefined ? {} : { title: options.title }),
      ...(options.timeoutMs === undefined ? {} : { timeout_ms: options.timeoutMs }),
    }, { timeoutMs: (options.timeoutMs ?? 120000) + 30000 });
    const texts = [];
    const images = [];
    for (const item of result.content) {
      if (item?.type === 'text' && typeof item.text === 'string') texts.push(item.text);
      else if (item?.type === 'image' && typeof item.data === 'string') {
        images.push({ data: item.data, mimeType: item.mimeType ?? 'image/png' });
      }
    }
    return { text: texts.join('\n'), images, isError: result.isError };
  }

  /**
   * Tell the trusted browser service that the current turn ended, then start a
   * new one. This is the same notification Codex delivers through its `Stop`
   * hook; without it a browser control session is never released.
   */
  async endTurn(hookEventName = 'Stop') {
    await this.start();
    const sessionId = this.sessionId;
    const turnId = this.turnId;
    await this.callTool('turn_ended', { hook_event_name: hookEventName, session_id: sessionId, turn_id: turnId }, { timeoutMs: 15000 });
    const match = /^turn-(\d+)$/.exec(turnId);
    this.turnId = `turn-${match === null ? 1 : Number.parseInt(match[1], 10) + 1}`;
    return { endedTurn: turnId, nextTurn: this.turnId };
  }

  /** Terminate the kernel. */
  async stop() {
    this.#closed = true;
    for (const [, entry] of this.#pending) entry.reject(new Error('node_repl bridge stopped'));
    this.#pending.clear();
    const child = this.#child;
    this.#child = null;
    if (child === null) return;
    await new Promise((resolve) => {
      const done = () => resolve();
      child.once('exit', done);
      child.kill('SIGTERM');
      setTimeout(() => {
        child.kill('SIGKILL');
        resolve();
      }, 3000).unref?.();
    });
  }
}
