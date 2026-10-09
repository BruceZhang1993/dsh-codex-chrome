/**
 * dsh-codex-chrome — browser session helper.
 *
 * IMPORTANT: this module is NOT imported by the DSH host. It is imported
 * *inside the Codex `node_repl` kernel* by `bin/chrome-mcp.mjs`, where the
 * privileged browser service, `globalThis.nodeRepl` and the browser-client
 * runtime all exist. Treat it as sandboxed code: only dynamic imports of
 * built-in modules and the vendor `browser-client.mjs` are available, and
 * `node:process` is intentionally out of reach.
 *
 * Persistence is deliberately NOT module scope. Each `js` tool call is
 * evaluated in its own realm with a fresh ESM registry — the same `import()`
 * specifier is re-evaluated on every call, so module-level bindings reset —
 * while `globalThis` is shared by the whole kernel. Session state therefore
 * lives on a single namespaced `globalThis` slot.
 *
 * @module dsh-codex-chrome/session
 */

/** Kernel-global slot holding this helper's live bindings. */
const STORE_KEY = '__dshCodexChrome';

/** @returns {{ agent: any, browsers: Map<string, any>, currentFamily: string|null, tabs: Map<string, any>, currentTabId: string|null, clientPath: string|null }} */
function store() {
  let slot = globalThis[STORE_KEY];
  if (slot === undefined || slot === null || typeof slot !== 'object') {
    slot = {
      agent: null,
      browsers: new Map(),
      currentFamily: null,
      tabs: new Map(),
      currentTabId: null,
      clientPath: null,
    };
    globalThis[STORE_KEY] = slot;
  }
  return slot;
}

/** Raised for caller mistakes; the bridge turns `code` into a tool-level error. */
class SessionError extends Error {
  constructor(message, code = 'invalid_request') {
    super(message);
    this.name = 'SessionError';
    this.code = code;
  }
}

const fail = (message, code) => {
  throw new SessionError(message, code);
};

/** Lazily create the `Agent` from the vendor browser-client, once per kernel. */
async function ensureAgent(config) {
  const state = store();
  if (state.agent !== null) return state.agent;
  const clientPath = config?.browserClientPath ?? state.clientPath;
  if (typeof clientPath !== 'string' || clientPath.length === 0) {
    fail('browser client path is unknown; set CODEX_HOME so the Codex chrome plugin can be found', 'not_configured');
  }
  state.clientPath = clientPath;
  const mod = await import(clientPath);
  if (typeof mod?.setupBrowserRuntime !== 'function') {
    fail(`browser client at ${clientPath} does not export setupBrowserRuntime`, 'not_configured');
  }
  state.agent = await mod.setupBrowserRuntime();
  return state.agent;
}

/**
 * Resolve the browser binding for a family.
 *
 * If no family is given, reuse the current binding; otherwise fall back to the
 * runtime default. A browser already bound for this session is always reused so
 * that a later call never silently switches the user's browser.
 */
async function ensureBrowser(args = {}) {
  const state = store();
  const agent = await ensureAgent(args.config);
  const family = args.family ?? null;
  const key = family ?? 'default';
  if (state.browsers.has(key)) return state.browsers.get(key);

  let browser;
  if (family === null || family === undefined || family === 'default') {
    browser = await agent.browsers.getDefault();
  } else if (family === 'auto' || family === 'url') {
    if (typeof args.url !== 'string' || args.url.length === 0) {
      fail('browser "auto" requires a url (pass the target URL, or name a browser)', 'invalid_request');
    }
    browser = await agent.browsers.getForUrl(args.url);
  } else {
    browser = await agent.browsers.get(family);
  }
  state.browsers.set(key, browser);
  if (state.currentFamily === null) state.currentFamily = key;
  return browser;
}

/** The browser binding currently in use. */
function currentBrowser() {
  const state = store();
  if (state.currentFamily !== null && state.browsers.has(state.currentFamily)) {
    return state.browsers.get(state.currentFamily);
  }
  const first = state.browsers.values().next();
  if (first.done) fail('no browser is selected yet; call chrome_select first', 'no_browser');
  return first.value;
}

/** Resolve an explicit tab id, the current tab, or create one. */
async function resolveTab(args = {}, { create = true } = {}) {
  const state = store();
  const browser = await ensureBrowser(args);
  const wanted = args.tabId ?? state.currentTabId;
  if (typeof wanted === 'string' && wanted.length > 0) {
    if (state.tabs.has(wanted)) {
      state.currentTabId = wanted;
      return state.tabs.get(wanted);
    }
    const tab = await browser.tabs.get(wanted);
    state.tabs.set(wanted, tab);
    state.currentTabId = wanted;
    return tab;
  }
  const selected = await browser.tabs.selected();
  if (selected != null) {
    state.tabs.set(selected.id, selected);
    state.currentTabId = selected.id;
    return selected;
  }
  const known = [...state.tabs.keys()];
  if (known.length > 0) {
    const id = known[known.length - 1];
    state.currentTabId = id;
    return state.tabs.get(id);
  }
  if (!create) fail('no tab is open in the selected browser', 'no_tab');
  const tab = await browser.tabs.new();
  state.tabs.set(tab.id, tab);
  state.currentTabId = tab.id;
  return tab;
}

/** Small, stable summary of a tab for tool output. */
async function summarize(tab) {
  let title = null;
  let url = null;
  try {
    title = (await tab.title()) ?? null;
  } catch {
    title = null;
  }
  try {
    url = (await tab.url()) ?? null;
  } catch {
    url = null;
  }
  return { tabId: tab.id, title, url };
}

function clamp(text, maxChars) {
  if (typeof text !== 'string') return { text, truncated: false };
  const limit = Number.isFinite(maxChars) && maxChars > 0 ? Math.floor(maxChars) : 200000;
  if (text.length <= limit) return { text, truncated: false };
  return { text: text.slice(0, limit), truncated: true, originalLength: text.length };
}

/**
 * Identify an image from its magic bytes.
 *
 * The vendor captures JPEG (despite the PNG-flavoured naming), so the declared
 * type has to come from the payload: DSH rejects an image whose declared type
 * does not match its bytes.
 */
function detectMimeType(bytes) {
  if (bytes.length >= 4 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 3 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return 'image/gif';
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  ) {
    return 'image/webp';
  }
  return 'image/png';
}

/**
 * Emit image bytes to the model through the Node REPL image channel.
 *
 * The kernel's filesystem turns read-only as soon as the vendor browser service
 * is active (every write returns EROFS, including `/tmp` and `$CODEX_HOME`), so
 * artifacts cannot be spooled to disk from inside the sandbox. `emitImage` is
 * the supported channel: the bytes come back as an MCP image block on the same
 * tool result, and the DSH bridge additionally saves a host-side copy.
 */
async function emitPng(bytes) {
  const mod = await import('node:buffer');
  const mimeType = detectMimeType(bytes);
  const base64 = mod.Buffer.from(bytes).toString('base64');
  const repl = globalThis.nodeRepl;
  if (repl !== undefined && typeof repl.emitImage === 'function') {
    await repl.emitImage(`data:${mimeType};base64,${base64}`);
  }
  return { bytes: bytes.length, mimeType, base64Length: base64.length };
}

/** Build a Playwright-style locator from a flat, JSON-friendly spec. */
function locatorFor(tab, spec) {
  if (spec == null || typeof spec !== 'object') fail('a locator spec is required', 'invalid_request');
  const pw = tab.playwright;
  let loc = null;
  if (typeof spec.selector === 'string' && spec.selector.length > 0) loc = pw.locator(spec.selector);
  else if (typeof spec.role === 'string' && spec.role.length > 0) {
    loc = pw.getByRole(spec.role, spec.name === undefined ? {} : { name: spec.name });
  } else if (typeof spec.text === 'string' && spec.text.length > 0) {
    loc = pw.getByText(spec.text, spec.exact === undefined ? {} : { exact: spec.exact });
  } else if (typeof spec.label === 'string' && spec.label.length > 0) {
    loc = pw.getByLabel(spec.label, spec.exact === undefined ? {} : { exact: spec.exact });
  } else if (typeof spec.placeholder === 'string' && spec.placeholder.length > 0) {
    loc = pw.getByPlaceholder(spec.placeholder, spec.exact === undefined ? {} : { exact: spec.exact });
  } else if (typeof spec.testId === 'string' && spec.testId.length > 0) {
    loc = pw.getByTestId(spec.testId);
  }
  if (loc === null) {
    fail('a locator needs one of: selector, role, text, label, placeholder, testId', 'invalid_request');
  }
  if (typeof spec.nth === 'number') loc = loc.nth(spec.nth);
  else if (spec.first === true) loc = loc.first();
  else if (spec.last === true) loc = loc.last();
  return loc;
}

/** Flat locator spec passed on the wire. */
function specOf(args) {
  return {
    selector: args.selector,
    role: args.role,
    name: args.name,
    text: args.matchText ?? args.text,
    label: args.label,
    placeholder: args.placeholder,
    testId: args.testId,
    nth: args.nth,
    first: args.first,
    last: args.last,
    exact: args.exact,
  };
}

const timeoutOption = (args) => (typeof args.timeoutMs === 'number' && args.timeoutMs > 0 ? { timeoutMs: args.timeoutMs } : {});

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

const ops = {
  /** Connection surface: which browsers exist, what is selected, which tabs are open. */
  async status(args) {
    const state = store();
    const agent = await ensureAgent(args.config);
    const browsers = await agent.browsers.list();
    let tabs = [];
    if (state.browsers.size > 0) {
      const browser = currentBrowser();
      tabs = await browser.tabs.list();
    }
    return {
      browsers,
      current: state.currentFamily,
      boundFamilies: [...state.browsers.keys()],
      tabs,
      currentTabId: state.currentTabId,
    };
  },

  /** Bind a browser family (or let the runtime pick one). */
  async select(args) {
    const state = store();
    const family = args.browser ?? 'default';
    if (state.browsers.has(family)) {
      state.currentFamily = family;
      return { browser: { id: state.browsers.get(family).browserId, name: family, reused: true } };
    }
    const browser = await ensureBrowser({ ...args, family, config: args.config });
    state.currentFamily = family;
    return { browser: { id: browser.browserId, name: family, reused: false } };
  },

  /** Tab inventory and lifecycle, including the user's own tabs. */
  async tabs(args) {
    const state = store();
    const action = args.action ?? 'list';
    if (action === 'user_tabs') {
      const browser = await ensureBrowser(args);
      return { tabs: await browser.user.openTabs() };
    }
    if (action === 'claim') {
      const browser = await ensureBrowser(args);
      if (typeof args.tabId !== 'string' || args.tabId.length === 0) {
        fail('action "claim" requires tabId from action "user_tabs"', 'invalid_request');
      }
      const tab = await browser.user.claimTab(args.tabId);
      state.tabs.set(tab.id, tab);
      state.currentTabId = tab.id;
      return { tab: await summarize(tab) };
    }
    if (action === 'list') {
      const browser = await ensureBrowser(args);
      return { tabs: await browser.tabs.list(), currentTabId: state.currentTabId };
    }
    if (action === 'select') {
      const tab = await resolveTab(args, { create: false });
      state.currentTabId = tab.id;
      return { tab: await summarize(tab) };
    }
    if (action === 'close') {
      const tab = await resolveTab(args, { create: false });
      const id = tab.id;
      await tab.close();
      state.tabs.delete(id);
      if (state.currentTabId === id) state.currentTabId = null;
      return { closed: id };
    }
    if (action === 'new') {
      const browser = await ensureBrowser(args);
      const tab = await browser.tabs.new();
      state.tabs.set(tab.id, tab);
      state.currentTabId = tab.id;
      const out = { tab: await summarize(tab) };
      if (typeof args.url === 'string' && args.url.length > 0) {
        try {
          await tab.goto(args.url);
          out.tab = await summarize(tab);
        } catch (error) {
          // The tab exists even when the navigation is refused (a browser
          // extension or policy can block it). Report both, so the caller can
          // keep the handle instead of losing it to an opaque failure.
          out.navigationError = String(error?.message ?? error);
          out.tab = await summarize(tab);
        }
      }
      return out;
    }
    fail(`unknown tabs action "${action}"`, 'invalid_request');
  },

  /** Navigation for a tab. */
  async navigate(args) {
    const action = args.action ?? 'goto';
    const tab = await resolveTab(args);
    if (action === 'goto') {
      if (typeof args.url !== 'string' || args.url.length === 0) fail('action "goto" requires url', 'invalid_request');
      await tab.goto(args.url);
    } else if (action === 'back') await tab.back();
    else if (action === 'forward') await tab.forward();
    else if (action === 'reload') await tab.reload();
    else fail(`unknown navigate action "${action}"`, 'invalid_request');
    return { ...(await summarize(tab)), action };
  },

  /**
   * Cheapest state check that answers the next question.
   * `state` is the accessibility tree (the vendor's preferred surface), `dom`
   * and `visible_dom` are DOM views, `screenshot`/`both` add an image.
   */
  async observe(args) {
    const mode = args.mode ?? 'state';
    const tab = await resolveTab(args);
    const out = { ...(await summarize(tab)), mode };
    if (mode === 'state' || mode === 'both') {
      const options = args.disableDiffing === true ? { disableDiffing: true } : undefined;
      if (mode === 'state') {
        const result = clamp(await tab.ax.get('state', options), args.maxChars);
        out.state = result.text;
        out.truncated = result.truncated;
      } else {
        const result = await tab.ax.get('both', options);
        const text = clamp(result.state, args.maxChars);
        out.state = text.text;
        out.truncated = text.truncated;
        if (result.screenshot != null) out.image = await emitPng(result.screenshot);
      }
      return out;
    }
    if (mode === 'screenshot') {
      const bytes = await tab.screenshot({ fullPage: args.fullPage === true });
      out.image = await emitPng(bytes);
      return out;
    }
    if (mode === 'dom') {
      const result = clamp(await tab.playwright.domSnapshot(), args.maxChars);
      out.dom = result.text;
      out.truncated = result.truncated;
      return out;
    }
    if (mode === 'visible_dom') {
      const dom = await tab.dom_cua.get_visible_dom();
      out.dom = clamp(typeof dom === 'string' ? dom : JSON.stringify(dom, null, 1), args.maxChars).text;
      return out;
    }
    fail(`unknown observe mode "${mode}"`, 'invalid_request');
  },

  /** Interact with the page: accessibility actions first, locator actions when needed. */
  async act(args) {
    const via = args.via ?? 'ax';
    const action = args.action;
    if (typeof action !== 'string' || action.length === 0) fail('act requires an action', 'invalid_request');
    const tab = await resolveTab(args);
    const out = { ...(await summarize(tab)), via, action };

    if (via === 'ax') {
      const index = typeof args.elementIndex === 'number' ? args.elementIndex : null;
      // Element indices are bound to the accessibility session the model last
      // observed. Reading the tree here re-binds that session inside this call,
      // which is what makes an index returned by chrome_observe usable.
      try {
        await tab.ax.get('state');
      } catch {
        /* a tab without an accessibility tree still supports coordinate actions */
      }
      if (action === 'click') {
        const target = args.point ?? index;
        if (target == null) fail('ax click requires elementIndex or point [x, y]', 'invalid_request');
        await tab.ax.click(target, args.key === undefined ? undefined : { key: args.key, duration: args.duration });
      } else if (action === 'setValue') {
        if (index == null) fail('ax setValue requires elementIndex', 'invalid_request');
        await tab.ax.setValue(index, String(args.value ?? ''));
      } else if (action === 'typeText') {
        await tab.ax.typeText(index, String(args.text ?? ''));
      } else if (action === 'pressKey') {
        await tab.ax.pressKey(index, String(args.key ?? ''), args.duration === undefined ? undefined : { duration: args.duration });
      } else if (action === 'paste') {
        if (index == null) fail('ax paste requires elementIndex', 'invalid_request');
        await tab.ax.paste(index, String(args.text ?? ''));
      } else if (action === 'scroll') {
        const target = args.point ?? index;
        if (target == null) fail('ax scroll requires elementIndex or point [x, y]', 'invalid_request');
        await tab.ax.scroll(target, args.direction ?? 'down', args.pages ?? 1);
      } else if (action === 'selectText') {
        if (index == null) fail('ax selectText requires elementIndex', 'invalid_request');
        await tab.ax.selectText(index, String(args.text ?? ''), args.selectionType === undefined ? undefined : { selectionType: args.selectionType });
      } else if (action === 'performSecondaryAction') {
        if (index == null) fail('ax performSecondaryAction requires elementIndex', 'invalid_request');
        await tab.ax.performSecondaryAction(index, String(args.secondaryAction ?? ''));
      } else if (action === 'drag') {
        if (!Array.isArray(args.from) || !Array.isArray(args.to)) fail('ax drag requires from and to [x, y]', 'invalid_request');
        await tab.ax.drag(args.from, args.to);
      } else {
        fail(`unsupported ax action "${action}"`, 'invalid_request');
      }
      return out;
    }

    if (via === 'locator') {
      const locator = locatorFor(tab, specOf(args));
      const to = timeoutOption(args);
      if (action === 'click') await locator.click(to);
      else if (action === 'dblclick') await locator.dblclick(to);
      else if (action === 'fill') await locator.fill(String(args.text ?? ''), to);
      else if (action === 'type') await locator.type(String(args.text ?? ''), to);
      else if (action === 'pressSequentially') await locator.pressSequentially(String(args.text ?? ''), to);
      else if (action === 'press') await locator.press(String(args.key ?? ''), to);
      else if (action === 'selectOption') {
        const values = Array.isArray(args.values) ? args.values : [args.values];
        await locator.selectOption(values, to);
      } else if (action === 'check') await locator.check(to);
      else if (action === 'uncheck') await locator.uncheck(to);
      else if (action === 'setChecked') await locator.setChecked(args.checked === true, to);
      else if (action === 'waitFor') await locator.waitFor({ state: args.state ?? 'visible', ...to });
      else if (action === 'count') return { ...out, count: await locator.count() };
      else if (action === 'isVisible') return { ...out, visible: await locator.isVisible() };
      else fail(`unsupported locator action "${action}"`, 'invalid_request');
      return out;
    }

    fail(`unknown act.via "${via}" (use "ax" or "locator")`, 'invalid_request');
  },

  /** Read data out of the page. */
  async read(args) {
    const tab = await resolveTab(args);
    const what = args.what ?? 'innerText';
    const locator = locatorFor(tab, specOf(args));
    const to = timeoutOption(args);
    const base = { ...(await summarize(tab)), what };
    if (what === 'innerText') return { ...base, value: clamp(await locator.innerText(to), args.maxChars).text };
    if (what === 'textContent') return { ...base, value: clamp(await locator.textContent(to), args.maxChars).text };
    if (what === 'allTextContents') return { ...base, values: await locator.allTextContents(to) };
    if (what === 'attribute') {
      if (typeof args.attribute !== 'string' || args.attribute.length === 0) fail('what "attribute" requires attribute', 'invalid_request');
      return { ...base, value: await locator.getAttribute(args.attribute, to) };
    }
    if (what === 'count') return { ...base, count: await locator.count() };
    if (what === 'isVisible') return { ...base, visible: await locator.isVisible() };
    if (what === 'isEnabled') return { ...base, enabled: await locator.isEnabled() };
    fail(`unknown read.what "${what}"`, 'invalid_request');
  },

  /** Evaluate a read-only expression in the page. */
  async evaluate(args) {
    const tab = await resolveTab(args);
    if (typeof args.expression !== 'string' || args.expression.length === 0) {
      fail('evaluate requires expression (a JavaScript expression or IIFE string)', 'invalid_request');
    }
    const value = await tab.playwright.evaluate(args.expression, args.arg, timeoutOption(args));
    return { ...(await summarize(tab)), value };
  },

  /** Wait for a page condition. */
  async wait(args) {
    const tab = await resolveTab(args);
    const kind = args.for ?? 'load';
    const to = timeoutOption(args);
    if (kind === 'url') {
      if (typeof args.url !== 'string' || args.url.length === 0) fail('wait "url" requires url', 'invalid_request');
      await tab.playwright.waitForURL(args.url, to);
    } else if (kind === 'load') {
      await tab.playwright.waitForLoadState({ state: args.state ?? 'load', ...to });
    } else if (kind === 'timeout') {
      await tab.playwright.waitForTimeout(typeof args.timeoutMs === 'number' ? args.timeoutMs : 1000);
    } else if (kind === 'selector') {
      const locator = locatorFor(tab, specOf(args));
      await locator.waitFor({ state: args.state ?? 'visible', ...to });
    } else {
      fail(`unknown wait.for "${kind}"`, 'invalid_request');
    }
    return { ...(await summarize(tab)), for: kind };
  },

  /** Drop local bindings; the next call re-selects and re-opens from scratch. */
  async reset() {
    const state = store();
    state.browsers.clear();
    state.tabs.clear();
    state.currentTabId = null;
    state.currentFamily = null;
    state.agent = null;
    return { reset: true };
  },
};

/**
 * Entry point used by the DSH bridge.
 *
 * @param {string} op - operation name (see `ops`).
 * @param {object} args - operation arguments (already JSON-decoded).
 * @returns {Promise<object>} JSON-serializable result.
 */
export async function dispatch(op, args = {}) {
  const handler = ops[op];
  if (typeof handler !== 'function') {
    return { ok: false, error: { code: 'unknown_op', message: `unknown chrome operation "${op}"` } };
  }
  try {
    const value = await handler(args ?? {});
    return { ok: true, ...value };
  } catch (error) {
    return {
      ok: false,
      error: {
        code: error?.code ?? 'browser_error',
        message: String(error?.message ?? error),
      },
    };
  }
}

/** Live bindings for the raw-JavaScript escape hatch. */
export async function context(config) {
  const agent = await ensureAgent(config);
  const browser = await ensureBrowser({ config });
  let tab = null;
  try {
    tab = await resolveTab({}, { create: false });
  } catch {
    tab = null;
  }
  return { agent, browser, tab };
}

/** Names accepted by `chrome_select`. */
export const BROWSER_FAMILIES = ['chrome', 'edge', 'brave', 'vivaldi', 'opera', 'extension', 'iab', 'default', 'auto'];
