<template>
  <div v-if="gate === 'locked'" class="gate">
    <div class="gate-card">
      <h1 class="gate-title">AI Code Executor</h1>
      <p class="gate-sub">Enter access token to continue</p>
      <input
        v-model="token"
        class="gate-input"
        type="password"
        placeholder="Access token"
        :disabled="gateBusy"
        @keydown.enter.prevent="submitToken"
      />
      <button class="gate-btn" :disabled="!token.trim() || gateBusy" @click="submitToken">
        {{ gateBusy ? "Checking…" : "Continue" }}
      </button>
      <p v-if="gateError" class="gate-err">{{ gateError }}</p>
    </div>
  </div>

  <div v-else-if="gate === 'open'" class="app">
    <header class="topbar">
      <div class="brand"><span class="logo">AI Code Executor</span><span class="tag">writes code · runs it in a Wasm sandbox · compares up to three models side by side</span></div>
      <div class="actions">
        <!-- Shared token budget: every pane's usage counts against the same pot. It
             survives "New Chat" (which only clears the conversations); the Reset
             button here is the only thing that refills it. -->
        <div class="budget" :class="{ over: budgetExhausted }" :title="`input + output tokens across all panes, out of a ${fmtTokens(TOKEN_BUDGET)}-token budget`">
          <span class="budget-label">Budget</span>
          <span class="budget-bar"><span class="budget-fill" :style="{ width: budgetPct + '%' }"></span></span>
          <span class="budget-nums">{{ fmtTokens(budgetUsed) }} / {{ fmtTokens(TOKEN_BUDGET) }}</span>
          <button class="ghost budget-reset" :disabled="anyLoading || budgetUsed === 0" @click="resetBudget">Reset</button>
        </div>
        <button class="ghost" @click="showHelp = true">How it works</button>
        <button class="ghost" @click="reset">New Chat</button>
      </div>
    </header>

    <!-- Pick how many models (1-2) and which ones to compare, up front: visible before the
         first prompt too, not just once the split panes exist. Locked once the comparison
         has a first message; "New Chat" unlocks it again. -->
    <div class="model-bar">
      <div class="lane-count">
        <span class="lane-count-label">Compare</span>
        <button
          v-for="n in [1, 2]"
          :key="n"
          type="button"
          class="count-btn"
          :class="{ active: laneCount === n }"
          :disabled="anyLoading || hasStarted"
          :title="hasStarted ? 'Start a New Chat to change this' : ''"
          @click="setLaneCount(n)"
        >
          {{ n }}
        </button>
      </div>
      <select
        v-for="lane in lanes"
        :key="lane.id"
        class="model-select"
        :class="laneClass(lane.id)"
        v-model="lane.model"
        :disabled="anyLoading || hasStarted || !availableModels.length"
        :title="hasStarted ? 'Start a New Chat to change this' : ''"
      >
        <option v-if="!availableModels.length" value="">{{ modelsError || "Loading models…" }}</option>
        <option v-for="m in availableModels" :key="m" :value="m">{{ m }}</option>
      </select>
    </div>

    <main class="main">
      <!-- empty state with predefined prompts -->
      <div v-if="lanes[0].messages.length === 0" class="scroll">
        <section class="welcome">
          <h2>What would you like to compute?</h2>
          <div class="suggestions">
            <button v-for="p in SUGGESTIONS" :key="p" class="suggestion" :disabled="budgetExhausted" @click="send(p)">{{ p }}</button>
          </div>
        </section>
      </div>

      <!-- split comparison: the same prompt runs on every chosen model at once, each in its own pane -->
      <div v-else class="split">
        <section v-for="lane in lanes" :key="lane.id" class="pane">
          <div class="pane-head">
            <span class="model-tag" :class="laneClass(lane.id)">{{ lane.model }}</span>
            <span v-if="laneUsage(lane)" class="usage-total" title="prompt + completion tokens, summed across this conversation">
              Σ {{ fmtTokens(laneUsage(lane)!.total) }} tokens
            </span>
          </div>

          <div class="scroll" :ref="(el) => setPaneRef(lane.id, el)">
            <section class="thread">
              <template v-for="(m, i) in lane.messages" :key="i">
                <div v-if="m.role === 'user'" class="user">{{ m.text }}</div>

                <div v-else class="assistant">
                  <p v-if="lane.loading && i === lane.messages.length - 1 && m.steps.length === 0" class="say muted">Thinking…</p>

                  <template v-for="(s, j) in m.steps" :key="j">
                    <div v-if="s.kind === 'text' && s.text.trim()" class="say md" v-html="s.html"></div>

                    <div v-else-if="s.kind === 'tool'" class="tool">
                      <div class="tool-head">
                        <span class="badge wasm_interpreter">⚡ Wasm interpreter</span>
                        <span class="lang">{{ s.language }}</span>
                        <span class="meta">{{ metaLabel(s) }}</span>
                      </div>
                      <!-- Extra npm packages bundled in + outbound hosts the model allow-listed for this run. -->
                      <div
                        v-if="(s.packages && Object.keys(s.packages).length) || (s.allowedHosts && s.allowedHosts.length)"
                        class="tool-deps"
                      >
                        <span v-for="(ver, name) in (s.packages || {})" :key="'p' + name" class="chip pkg" title="npm package bundled in">
                          <span class="chip-ico">📦</span>{{ name }}<span class="chip-ver">{{ ver }}</span>
                        </span>
                        <span v-for="h in (s.allowedHosts || [])" :key="'h' + h" class="chip host" title="allowed outbound host">
                          <span class="chip-ico">🌐</span>{{ h }}
                        </span>
                      </div>
                      <pre class="code"><code class="hljs" v-html="highlightCode(s.code, s.language)"></code></pre>
                      <pre v-if="s.stdout" class="out">{{ s.stdout }}</pre>
                      <pre v-if="s.stderr" class="out err">{{ s.stderr }}</pre>
                      <pre v-if="s.error" class="out err">⚠ {{ s.error }}</pre>
                    </div>
                  </template>

                  <p v-if="m.usage" class="say muted usage-meta">
                    {{ fmtTokens(m.usage.input) }} in · {{ fmtTokens(m.usage.output) }} out ·
                    {{ fmtTokens(m.usage.input + m.usage.output) }} total tokens
                  </p>
                </div>
              </template>

              <div v-if="lane.error" class="assistant"><p class="say err">⚠ {{ lane.error }}</p></div>
            </section>
          </div>
        </section>
      </div>
    </main>

    <footer class="composer">
      <textarea
        v-model="draft"
        :disabled="anyLoading || budgetExhausted"
        rows="1"
        :placeholder="budgetExhausted ? 'Token budget exhausted — press Reset in the header to continue' : 'Ask me to run some code…'"
        @keydown.enter.exact.prevent="send()"
      />
      <button class="send" :disabled="anyLoading || budgetExhausted || !draft.trim()" @click="send()">Send</button>
    </footer>

    <!-- How it works: the generate → execute → observe loop -->
    <div v-if="showHelp" class="help-overlay" @click.self="showHelp = false">
      <div class="help-card">
        <button class="help-close" @click="showHelp = false" aria-label="Close">×</button>
        <h2 class="help-title">How it works</h2>
        <p class="help-lede">
          This is a chat assistant that solves tasks by writing and running code. Ask it to
          compute, parse, or transform something: it writes a short program, runs it, and
          answers from the real output, fixing and re-running if the code fails.
        </p>
        <p class="help-lede">
          That code is written by the model, so it is untrusted. Each run executes in a
          <strong>WebAssembly sandbox</strong>: isolated from the host, no filesystem, no
          network unless a request allows it, and near-instant to start (milliseconds, no
          container cold-start), so running fresh code on every request stays cheap.
        </p>
        <p class="help-lede">
          Every question runs on <strong>up to three models at once</strong> — pick the
          count with the "Compare" buttons — each in its own pane with its own dropdown,
          so you can compare how the models your server offers write and reason about the
          same code side by side.
        </p>

        <div class="diagram">
          <svg viewBox="0 0 720 250" role="img" aria-label="A loop: you ask, each model writes code, a private Wasm sandbox runs it, the output feeds back to the model, which answers.">
            <defs>
              <marker id="ah" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                <path d="M0 0 L10 5 L0 10 z" fill="#9aa0a8" />
              </marker>
              <marker id="ahb" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                <path d="M0 0 L10 5 L0 10 z" fill="#1d4ed8" />
              </marker>
            </defs>

            <!-- loop: sandbox output feeds back to the model -->
            <path d="M475 118 C 475 52, 251 52, 251 118" fill="none" stroke="#1d4ed8" stroke-width="1.6" stroke-dasharray="5 4" marker-end="url(#ahb)" />
            <text x="363" y="44" text-anchor="middle" font-size="12.5" fill="#1d4ed8" font-weight="600">stdout / stderr fed back</text>

            <!-- forward arrows -->
            <line x1="112" y1="150" x2="170" y2="150" stroke="#9aa0a8" stroke-width="1.6" marker-end="url(#ah)" />
            <text x="141" y="141" text-anchor="middle" font-size="11.5" fill="#8a8f98">ask</text>
            <line x1="326" y1="150" x2="384" y2="150" stroke="#9aa0a8" stroke-width="1.6" marker-end="url(#ah)" />
            <text x="355" y="141" text-anchor="middle" font-size="11.5" fill="#8a8f98">code</text>
            <line x1="560" y1="150" x2="618" y2="150" stroke="#9aa0a8" stroke-width="1.6" marker-end="url(#ah)" />
            <text x="592" y="141" text-anchor="middle" font-size="11.5" fill="#8a8f98">answer</text>

            <!-- nodes -->
            <rect x="16" y="120" width="96" height="60" rx="12" fill="#fff" stroke="#d7dbe0" />
            <text x="64" y="155" text-anchor="middle" font-size="14" fill="#1f2328" font-weight="600">You</text>

            <rect x="176" y="120" width="150" height="60" rx="12" fill="#eef4ff" stroke="#c7d7fe" />
            <text x="251" y="146" text-anchor="middle" font-size="13.5" fill="#1d4ed8" font-weight="700">Each model</text>
            <text x="251" y="165" text-anchor="middle" font-size="12" fill="#3b5bdb">writes code</text>

            <rect x="390" y="120" width="170" height="60" rx="12" fill="#ecfdf5" stroke="#a7f3d0" />
            <text x="475" y="146" text-anchor="middle" font-size="13" fill="#047857" font-weight="700">Private Wasm sandbox</text>
            <text x="475" y="165" text-anchor="middle" font-size="12" fill="#059669">runs the code</text>

            <rect x="624" y="120" width="80" height="60" rx="12" fill="#1f2328" />
            <text x="664" y="155" text-anchor="middle" font-size="13" fill="#fff" font-weight="600">Answer</text>

            <text x="475" y="200" text-anchor="middle" font-size="11" fill="#8a8f98">isolated · private · no filesystem · default-deny network</text>
          </svg>
        </div>

        <ol class="help-steps">
          <li><span class="n">1</span>
            <div><strong>You ask.</strong> A question goes into the chat.</div>
          </li>
          <li><span class="n">2</span>
            <div><strong>Each model writes code.</strong> It picks Python or JavaScript and produces a small program.</div>
          </li>
          <li><span class="n">3</span>
            <div><strong>A private Wasm sandbox runs it.</strong> The code executes in an isolated WebAssembly interpreter: no filesystem, no shell, default-deny network.</div>
          </li>
          <li><span class="n">4</span>
            <div><strong>The output loops back.</strong> stdout, stderr and errors return to the model, which fixes-and-reruns or, once satisfied, writes the final answer.</div>
          </li>
        </ol>

        <p class="help-why-title">Why write code instead of only calling fixed tools?</p>
        <ul class="help-why">
          <li><strong>Open-ended</strong>: anything the sandbox can run, not just the tools that were pre-bundled.</li>
          <li><strong>Fewer round-trips</strong>: one program with real control flow, instead of a model turn per tool call.</li>
          <li><strong>Verifiable</strong>: a real interpreter computes the result; the model doesn't guess.</li>
        </ul>
        <p class="help-refs">
          Further reading:
          <a href="https://arxiv.org/pdf/2210.03629" target="_blank" rel="noopener">ReAct</a> (ICLR 2023) ·
          <a href="https://machinelearning.apple.com/research/codeact" target="_blank" rel="noopener">CodeAct</a> (Apple, 2024).
        </p>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, computed, nextTick } from "vue";
import MarkdownIt from "markdown-it";
import hljs from "highlight.js/lib/core";
import javascript from "highlight.js/lib/languages/javascript";
import typescript from "highlight.js/lib/languages/typescript";
import python from "highlight.js/lib/languages/python";
import bash from "highlight.js/lib/languages/bash";
import json from "highlight.js/lib/languages/json";
import sql from "highlight.js/lib/languages/sql";
import xml from "highlight.js/lib/languages/xml";
import cssLang from "highlight.js/lib/languages/css";
import yaml from "highlight.js/lib/languages/yaml";
import go from "highlight.js/lib/languages/go";
import rust from "highlight.js/lib/languages/rust";
import markdownLang from "highlight.js/lib/languages/markdown";
import diff from "highlight.js/lib/languages/diff";
import "highlight.js/styles/github.css";

// Register a focused language set (each registers its own aliases too: js, ts,
// py, sh, …), leaner than the full highlight.js build, covering what the model
// emits in code and prose.
for (const [name, lang] of Object.entries({
  javascript, typescript, python, bash, json, sql, xml, css: cssLang, yaml, go, rust, markdown: markdownLang, diff,
})) {
  hljs.registerLanguage(name, lang);
}

// Syntax-highlight a code string for a known language; falls back to escaped
// plain text (the returned HTML is highlight.js spans or escaped text, so it is safe).
// Memoized so that, while streaming, already-finished code blocks (stable input)
// are not re-highlighted on every token; only the in-progress block changes.
const hlCache = new Map<string, string>();
function highlightCode(code: string, lang?: string): string {
  const key = (lang || "") + " " + code;
  const cached = hlCache.get(key);
  if (cached !== undefined) return cached;
  let out: string;
  if (lang && hljs.getLanguage(lang)) {
    try {
      out = hljs.highlight(code, { language: lang, ignoreIllegals: true }).value;
    } catch {
      out = md.utils.escapeHtml(code);
    }
  } else {
    out = md.utils.escapeHtml(code);
  }
  if (hlCache.size > 500) hlCache.delete(hlCache.keys().next().value as string);
  hlCache.set(key, out);
  return out;
}

// markdown-it with raw HTML DISABLED: the model's text is untrusted, so any HTML
// in it is escaped rather than rendered, which makes v-html of this output
// XSS-safe. GitHub-style line breaks + autolinking; fenced code is highlighted.
const md = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: true,
  highlight(code, lang): string {
    // Only ever interpolate a REGISTERED language name (always a safe [a-z0-9-]
    // identifier) into the class: the fence's lang token is model-controlled and
    // unescaped here, so echoing it raw would let `lang` break out of the
    // attribute and inject markup into the v-html'd output.
    const known = lang && hljs.getLanguage(lang) ? lang : "";
    const cls = known ? `hljs language-${known}` : "hljs";
    return `<pre class="hl"><code class="${cls}">${highlightCode(code, known || undefined)}</code></pre>`;
  },
});

// Links come from the model → open in a new tab and harden with rel=noopener.
const defaultLinkOpen =
  md.renderer.rules.link_open ??
  ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options));
md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
  tokens[idx].attrSet("target", "_blank");
  tokens[idx].attrSet("rel", "noopener noreferrer");
  return defaultLinkOpen(tokens, idx, options, env, self);
};

// SECURITY: markdown-it's default link validation is not enough for untrusted
// model output. Its blocklist runs after a plain trim(), so a scheme split by an
// encoded tab/newline slips through: `[x](java&NewLine;script:alert(1))` becomes
// the href `java%0Ascript:…`, which the default regex misses but which a browser
// can re-assemble into `javascript:`. By the time validateLink runs the href is
// already percent-encoded, so we replicate the browser: percent-decode, drop the
// ASCII control chars + spaces it ignores, then ALLOWLIST safe schemes (relative
// and anchor links have none) and reject everything else.
md.validateLink = (url: string): boolean => {
  let decoded = url;
  try {
    decoded = decodeURIComponent(url);
  } catch {
    // malformed % escape, fall back to the raw string
  }
  let s = "";
  for (const ch of decoded) if (ch.charCodeAt(0) > 0x20) s += ch;
  const m = s.toLowerCase().match(/^([a-z][a-z0-9+.\-]*):/);
  return !m || ["http", "https", "mailto", "tel"].includes(m[1]);
};

// A sentinel appended to streamed text so a blinking caret can be injected at the
// very end of the rendered markdown (inside the last block, reading as a typing
// cursor) without disturbing the markdown parse. Invisible word-joiners + an
// unlikely token keep it from ever appearing in real model text.
const CARET = "⁠⁠execcaret⁠⁠";
function renderMarkdown(text: string, streaming = false): string {
  const html = md.render(streaming ? text + CARET : text);
  return streaming ? html.replace(CARET, '<span class="cursor">▍</span>') : html;
}

type Step =
  // `html` is the rendered markdown (updated on an animation frame, not on every
  // token); `streaming` is true while this block is still being written (drives
  // the caret).
  | { kind: "text"; block: string; text: string; html: string; streaming: boolean }
  | {
      kind: "tool";
      id: number;
      language: string;
      code: string;
      // Extra npm packages bundled in (name -> semver) and outbound hosts allow-listed for this run.
      packages?: Record<string, string>;
      allowedHosts?: string[];
      stdout: string;
      stderr: string;
      error: string | null;
      genMs: number;
      execMs: number;
      running: boolean;
    };

// Token usage for the turns it took to answer one prompt (an agentic run can take more
// than one model turn when it calls the tool more than once), reported once the answer
// is done; see the `done` WireEvent in api/src/index.ts.
type Usage = { input: number; output: number };
type Assistant = { role: "assistant"; steps: Step[]; usage?: Usage };
type Msg = { role: "user"; text: string } | Assistant;

function fmtTokens(n: number): string {
  return n.toLocaleString();
}

// ---- shared token budget ----
// One pot for the whole session: every lane's input + output tokens count against it, so
// comparing two models burns it twice as fast. It is deliberately *not* derived from the
// lanes' messages (unlike laneUsage below): "New Chat" clears those, but spent tokens
// stay spent. Only the header's Reset button refills it. In-memory only, so a page
// reload also starts fresh. When exhausted, sending is blocked (the composer and the
// suggestion buttons disable); an in-flight run still finishes and its usage is counted,
// so the meter can overshoot the budget.
const TOKEN_BUDGET = 10_000;
const budgetUsed = ref(0);
const budgetExhausted = computed(() => budgetUsed.value >= TOKEN_BUDGET);
const budgetPct = computed(() => Math.min(100, (budgetUsed.value / TOKEN_BUDGET) * 100));
function resetBudget() {
  if (anyLoading.value) return;
  budgetUsed.value = 0;
}

// Two independent conversations run side by side, each pinned to a model id the user
// picks from a dropdown. The dropdown's options come from GET /api/models (the server
// behind `model_base_url`), not a hardcoded list, so it reflects whatever that server
// actually serves. Lanes are identified by a fixed `id` (not the model, which the user
// can change, including to the same model as the other lane).
function laneClass(id: number): string {
  return `lane-${id}`;
}

type TextStep = Extract<Step, { kind: "text" }>;

// Coalesce markdown re-renders to at most one per animation frame. Streaming text
// is re-parsed ~60×/s instead of once per token, so a long answer (with code
// blocks) doesn't spend O(n²) main-thread time re-parsing the whole document on
// every delta.
let rafQueued = false;
const dirtySteps = new Set<TextStep>();
function flushRenders() {
  rafQueued = false;
  for (const s of dirtySteps) s.html = renderMarkdown(s.text, s.streaming);
  dirtySteps.clear();
}
function scheduleRender(s: TextStep) {
  dirtySteps.add(s);
  if (rafQueued) return;
  rafQueued = true;
  const raf = (globalThis as { requestAnimationFrame?: (cb: () => void) => number }).requestAnimationFrame;
  if (raf) raf(flushRenders);
  else setTimeout(flushRenders, 16);
}
// Finalize any still-streaming text blocks: render once more without the caret.
function finalizeText(a: Assistant) {
  for (const s of a.steps) {
    if (s.kind === "text" && s.streaming) {
      s.streaming = false;
      s.html = renderMarkdown(s.text, false);
    }
  }
}

const SUGGESTIONS = [
  "Calculate the first 20 Fibonacci numbers",
  "Generate 10 random numbers and sort them",
  "What is the factorial of 15?",
  "Write a function that checks if a string is a palindrome, then test it",
  "Parse a CSV of employees and print the average salary",
];

// One independent conversation per lane: own transcript, own round-tripped history, own
// loading/error state, so each runs (and can fail) without affecting the others. `model`
// starts empty and is filled in once GET /api/models resolves (see loadModels below).
type Lane = {
  id: number;
  model: string;
  messages: Msg[];
  history: unknown;
  loading: boolean;
  error: string;
};

// How many models to compare at once (1-2), chosen via the "Compare" buttons. Changing it
// rebuilds the lane list from scratch: a different count is a different comparison, so
// there is no sane way to carry an old conversation over.
const laneCount = ref(2);
const lanes = reactive<Lane[]>([]);
const anyLoading = computed(() => lanes.some((l) => l.loading));
// Once a comparison has a first message, lock the count and model pickers so you can't
// silently swap a model (or the number of panes) mid-conversation; "New Chat" (reset)
// clears every lane's messages, which unlocks them again.
const hasStarted = computed(() => lanes[0]?.messages.length > 0);

// Populated from GET /api/models; each lane's <select> lists these.
const availableModels = ref<string[]>([]);
const modelsError = ref("");

// Defaults each unset lane to a distinct model (cycling if the server serves fewer models
// than lanes). Called once models load, and again whenever the lane count changes.
function assignDefaultModels() {
  if (!availableModels.value.length) return;
  lanes.forEach((lane, i) => {
    if (!lane.model) lane.model = availableModels.value[i % availableModels.value.length];
  });
}

function buildLanes(n: number) {
  lanes.splice(0, lanes.length);
  for (let id = 0; id < n; id++) {
    lanes.push({ id, model: "", messages: [], history: null, loading: false, error: "" });
  }
  assignDefaultModels();
}
function setLaneCount(n: number) {
  if (n === laneCount.value || anyLoading.value) return;
  laneCount.value = n;
  buildLanes(n);
}
buildLanes(laneCount.value);

async function loadModels() {
  try {
    const resp = await fetch("/api/models");
    // The response may not be JSON at all (e.g. a stale build predating this route, or an
    // upstream error page), so parse defensively instead of letting a SyntaxError surface
    // as the error message.
    const d = await resp.json().catch(() => null);
    if (!resp.ok || !d || !Array.isArray(d.models) || d.models.length === 0) {
      throw new Error(d?.error || `could not load models (${resp.status})`);
    }
    availableModels.value = d.models;
    assignDefaultModels();
  } catch (e: any) {
    modelsError.value = String(e?.message ?? e);
  }
}

const draft = ref("");
const showHelp = ref(false); // "How it works" overlay

// Each pane scrolls independently; function refs key the live elements by lane id (not the
// model, which the user can change, including to the same model as the other lane).
const paneRefs: Record<number, HTMLElement | null> = {};
function setPaneRef(id: number, el: unknown) {
  paneRefs[id] = (el as HTMLElement) ?? null;
}

// ---- access-token gate ----
const gate = ref<"checking" | "locked" | "open">("checking");
const token = ref("");
const gateBusy = ref(false);
const gateError = ref("");

async function checkAuth() {
  try {
    const d = await (await fetch("/api/health")).json();
    gate.value = !d.authRequired || d.authed ? "open" : "locked";
  } catch {
    gate.value = "open"; // health unreachable, don't hard-lock local dev
  }
  if (gate.value === "open") loadModels();
}
async function submitToken() {
  const t = token.value.trim();
  if (!t || gateBusy.value) return;
  gateBusy.value = true;
  gateError.value = "";
  try {
    const r = await fetch("/api/auth", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: t }),
    });
    if (r.ok) {
      gate.value = "open";
      loadModels();
    } else {
      gateError.value = "Invalid access token";
    }
  } catch {
    gateError.value = "Could not verify. Try again.";
  } finally {
    gateBusy.value = false;
  }
}
checkAuth();

function fmt(ms: number): string {
  if (ms == null) return ", ";
  return ms >= 1000 ? (ms / 1000).toFixed(1) + "s" : Math.round(ms) + "ms";
}

function metaLabel(s: Extract<Step, { kind: "tool" }>): string {
  if (s.running) return `generated in ${fmt(s.genMs)} · running…`;
  return `generated in ${fmt(s.genMs)} · ran in ${fmt(s.execMs)}`;
}

async function toBottom(laneId: number) {
  await nextTick();
  const el = paneRefs[laneId];
  el?.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
}

function reset() {
  for (const lane of lanes) {
    lane.messages = [];
    lane.history = null; // forget the prior conversation
    lane.error = "";
  }
  draft.value = "";
}

// Apply one streamed NDJSON event to the live assistant message. The `model` event just
// confirms which model this pane's request was pinned to, so there is nothing to do with it.
function apply(a: Assistant, ev: any) {
  if (ev.t === "model") {
    // no-op: the pane already knows its model
  } else if (ev.t === "text_delta") {
    // Append to the live text block, or start a new one, so the model's text
    // grows on screen token-by-token as it is received.
    let s = a.steps.find((x) => x.kind === "text" && x.block === ev.block) as TextStep | undefined;
    if (!s) {
      finalizeText(a); // a new block began, drop the caret from the previous one
      s = { kind: "text", block: ev.block, text: "", html: "", streaming: true };
      a.steps.push(s);
    }
    s.text += ev.text;
    // Render the first chunk now (cheap, avoids a blank frame); coalesce the rest.
    if (!s.html) s.html = renderMarkdown(s.text, true);
    else scheduleRender(s);
  } else if (ev.t === "tool_start") {
    finalizeText(a); // text before a tool call is done, stop its caret
    a.steps.push({
      kind: "tool",
      id: ev.id,
      language: ev.language,
      code: ev.code,
      packages: ev.packages,
      allowedHosts: ev.allowedHosts,
      genMs: ev.genMs,
      execMs: 0,
      stdout: "",
      stderr: "",
      error: null,
      running: true,
    });
  } else if (ev.t === "tool_end") {
    const s = a.steps.find((x) => x.kind === "tool" && x.id === ev.id) as Extract<Step, { kind: "tool" }> | undefined;
    if (s) {
      s.running = false;
      s.execMs = ev.execMs;
      s.stdout = ev.stdout;
      s.stderr = ev.stderr;
      s.error = ev.error;
    }
  } else if (ev.t === "error") {
    finalizeText(a);
    throw new Error(ev.error);
  } else if (ev.t === "done") {
    finalizeText(a); // the turn is over, settle the final text without a caret
    if (ev.usage) {
      a.usage = ev.usage;
      budgetUsed.value += ev.usage.input + ev.usage.output;
    }
  }
}

// Sums every assistant turn's usage in a lane, so the pane header shows a running total
// for the whole conversation, not just the latest answer. Returns null until there's any.
function laneUsage(lane: Lane): { input: number; output: number; total: number } | null {
  let input = 0;
  let output = 0;
  let any = false;
  for (const m of lane.messages) {
    if (m.role === "assistant" && m.usage) {
      input += m.usage.input;
      output += m.usage.output;
      any = true;
    }
  }
  return any ? { input, output, total: input + output } : null;
}

// Send the same prompt to every lane at once, in parallel, each continuing its own
// conversation (own history, own failure mode) so the answers are directly comparable.
async function send(text?: string) {
  const prompt = (text ?? draft.value).trim();
  if (!prompt || anyLoading.value || budgetExhausted.value) return;
  draft.value = "";
  for (const lane of lanes) {
    lane.error = "";
    lane.messages.push({ role: "user", text: prompt });
  }
  await Promise.all(lanes.map((lane) => runLane(lane, prompt)));
}

async function runLane(lane: Lane, prompt: string) {
  lane.loading = true;
  const assistant = reactive<Assistant>({ role: "assistant", steps: [] });
  lane.messages.push(assistant);
  await toBottom(lane.id);

  try {
    const resp = await fetch("/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt, history: lane.history, model: lane.model }),
    });
    if (!resp.ok || !resp.body) {
      const data = await resp.json().catch(() => ({}));
      throw new Error(data?.error || `request failed (${resp.status})`);
    }

    // Read the NDJSON stream line by line, rendering each event as it arrives.
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        const ev = JSON.parse(line);
        if (ev.t === "done" && ev.history) lane.history = ev.history; // carry context to the next turn
        apply(assistant, ev);
        await toBottom(lane.id);
      }
    }
  } catch (e: any) {
    lane.error = String(e?.message ?? e);
  } finally {
    lane.loading = false;
    finalizeText(assistant); // settle any text whose stream ended without a done event
    await toBottom(lane.id);
  }
}
</script>

<style>
* { box-sizing: border-box; }
html, body, #__nuxt { height: 100%; margin: 0; }
body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; color: #1f2328; background: #fafafa; }
.app { display: flex; flex-direction: column; height: 100vh; }

.topbar { display: flex; align-items: center; justify-content: space-between; padding: 14px 22px; border-bottom: 1px solid #ececec; background: #fff; }
.brand { display: flex; align-items: baseline; gap: 10px; }
.logo { font-weight: 700; font-size: 18px; }
.tag { color: #8a8f98; font-size: 14px; }
.actions { display: flex; align-items: center; gap: 16px; }
.ghost { background: #fff; border: 1px solid #e2e2e2; border-radius: 8px; padding: 7px 14px; font-size: 14px; cursor: pointer; }
.ghost:hover { background: #f6f6f6; }
.ghost:disabled { cursor: not-allowed; opacity: 0.6; }

/* shared token budget meter */
.budget { display: flex; align-items: center; gap: 8px; }
.budget-label { font-size: 12.5px; color: #8a8f98; font-weight: 600; }
.budget-bar { width: 110px; height: 7px; border-radius: 999px; background: #eef0f2; overflow: hidden; }
.budget-fill { display: block; height: 100%; border-radius: 999px; background: #15803d; transition: width 0.3s ease; }
.budget.over .budget-fill { background: #b42318; }
.budget-nums { font-size: 12px; color: #5a6069; font-variant-numeric: tabular-nums; }
.budget.over .budget-nums { color: #b42318; font-weight: 600; }
.budget-reset { padding: 4px 10px; font-size: 12.5px; }

.main { flex: 1; display: flex; flex-direction: column; min-height: 0; }
.scroll { flex: 1; min-height: 0; overflow-y: auto; }
.welcome { max-width: 620px; margin: 9vh auto 0; text-align: center; padding: 0 20px; }
.welcome h2 { font-weight: 600; color: #3a3f45; }
.suggestions { display: flex; flex-direction: column; gap: 12px; margin-top: 28px; }
.suggestion { text-align: left; background: #fff; border: 1px solid #e7e7e7; border-radius: 12px; padding: 16px 18px; font-size: 15px; cursor: pointer; }
.suggestion:hover:not(:disabled) { border-color: #cfcfcf; box-shadow: 0 1px 4px rgba(0,0,0,0.04); }
.suggestion:disabled { cursor: not-allowed; opacity: 0.6; }

/* split comparison: two independently-scrolling panes, one per model */
.split { flex: 1; min-height: 0; display: flex; }
.pane { flex: 1; min-width: 0; display: flex; flex-direction: column; min-height: 0; border-right: 1px solid #ececec; }
.pane:last-child { border-right: none; }
.pane-head { flex: 0 0 auto; display: flex; align-items: center; gap: 10px; padding: 10px 20px; border-bottom: 1px solid #ececec; background: #fff; }
.usage-total { font-size: 11.5px; color: #8a8f98; font-variant-numeric: tabular-nums; }

.thread { padding: 20px 20px 8px; display: flex; flex-direction: column; gap: 16px; }
.user { align-self: flex-end; background: #1f2328; color: #fff; padding: 10px 14px; border-radius: 14px 14px 4px 14px; max-width: 80%; white-space: pre-wrap; }
.assistant { display: flex; flex-direction: column; gap: 12px; max-width: 92%; }
.say { margin: 0; line-height: 1.55; white-space: pre-wrap; }
.say.muted { color: #8a8f98; }
.usage-meta { font-size: 11.5px; font-variant-numeric: tabular-nums; }
.say.err, .out.err { color: #b42318; }
.cursor { color: #6b7280; font-weight: 600; animation: blink 1s steps(1) infinite; }
@keyframes blink { 50% { opacity: 0; } }

/* rendered markdown */
.md { white-space: normal; line-height: 1.6; }
.md > :first-child { margin-top: 0; }
.md > :last-child { margin-bottom: 0; }
.md p { margin: 0 0 10px; }
.md h1, .md h2, .md h3, .md h4 { margin: 16px 0 8px; font-weight: 650; line-height: 1.3; }
.md h1 { font-size: 1.4em; }
.md h2 { font-size: 1.25em; }
.md h3 { font-size: 1.1em; }
.md h4 { font-size: 1em; }
.md ul, .md ol { margin: 0 0 10px; padding-left: 22px; }
.md li { margin: 3px 0; }
.md li > p { margin: 0; }
.md a { color: #1d4ed8; text-decoration: underline; }
.md blockquote { margin: 0 0 10px; padding: 2px 12px; border-left: 3px solid #e2e2e2; color: #5a6069; }
.md hr { border: none; border-top: 1px solid #ececec; margin: 14px 0; }
.md table { border-collapse: collapse; margin: 0 0 10px; font-size: 13.5px; }
.md th, .md td { border: 1px solid #e7e7e7; padding: 5px 10px; text-align: left; }
.md th { background: #f6f6f6; }
/* inline code (not the highlighted fenced blocks) */
.md code:not(.hljs) { background: #f1f2f4; padding: 1.5px 5px; border-radius: 5px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.88em; }
/* fenced code block */
.md pre.hl { margin: 0 0 10px; border: 1px solid #ececec; border-radius: 10px; overflow: hidden; background: #f8fafc; }
.md pre.hl code.hljs { background: #f8fafc; padding: 12px 14px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12.5px; line-height: 1.5; }

.model-bar { display: flex; align-items: center; gap: 10px; padding: 10px 22px; border-bottom: 1px solid #ececec; background: #fff; }
.lane-count { display: flex; align-items: center; gap: 6px; margin-right: 6px; }
.lane-count-label { font-size: 12.5px; color: #8a8f98; font-weight: 600; }
.count-btn { width: 26px; height: 26px; border-radius: 8px; border: 1px solid #e2e2e2; background: #fff; font-size: 12.5px; font-weight: 700; color: #3a3f45; cursor: pointer; }
.count-btn:hover:not(:disabled) { background: #f6f6f6; }
.count-btn.active { background: #1f2328; color: #fff; border-color: #1f2328; }
.count-btn:disabled { cursor: not-allowed; opacity: 0.6; }
.model-tag, .model-select { font-size: 11.5px; font-weight: 700; letter-spacing: 0.02em; padding: 3px 10px; border-radius: 999px; border: 1px solid transparent; }
.model-tag { align-self: flex-start; }
.model-select { padding-right: 24px; font-family: inherit; cursor: pointer; appearance: none; background-repeat: no-repeat; background-position: right 8px center; background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6'%3E%3Cpath d='M0 0l5 6 5-6z' fill='%238a8f98'/%3E%3C/svg%3E"); }
.model-select:disabled { cursor: default; opacity: 0.7; }
.model-tag.lane-0, .model-select.lane-0 { background-color: #eafbea; color: #15803d; border-color: #c9f0cc; }
.model-tag.lane-1, .model-select.lane-1 { background-color: #f3ecfd; color: #7e22ce; border-color: #e3d4fb; }
.model-tag.lane-2, .model-select.lane-2 { background-color: #fff4e5; color: #b45309; border-color: #fde3b8; }

.tool { border: 1px solid #e7e7e7; border-radius: 12px; overflow: hidden; background: #fff; }
.tool-head { display: flex; align-items: center; gap: 10px; padding: 9px 12px; border-bottom: 1px solid #f0f0f0; background: #fbfbfb; }
.badge { font-size: 12.5px; font-weight: 600; padding: 3px 9px; border-radius: 999px; }
.badge.wasm_interpreter { background: #eef4ff; color: #1d4ed8; }
.lang { font-size: 12.5px; color: #8a8f98; }
.meta { margin-left: auto; font-size: 12px; color: #9aa0a8; font-variant-numeric: tabular-nums; }
.code { margin: 0; padding: 12px 14px; font-size: 13px; line-height: 1.5; overflow-x: auto; background: #fff; }
.code code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
/* the tool-card code is highlighted; drop highlight.js's own block padding/bg so the card controls layout */
.code code.hljs { padding: 0; background: transparent; }
/* Packages bundled in + hosts allow-listed for this run, shown between the head and the code. */
.tool-deps { display: flex; flex-wrap: wrap; gap: 6px; padding: 8px 12px; border-bottom: 1px solid #f0f0f0; background: #fcfcfd; }
.chip { display: inline-flex; align-items: center; gap: 5px; font-size: 12px; font-weight: 500; padding: 3px 9px; border-radius: 999px; border: 1px solid transparent; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
.chip-ico { font-size: 11px; }
.chip.pkg { background: #eef7f0; color: #226b39; border-color: #dcefe1; }
.chip.pkg .chip-ver { color: #6f9a7e; margin-left: 4px; font-weight: 400; }
.chip.host { background: #fff5e8; color: #9a5b06; border-color: #f6e2c6; }
.out { margin: 0; padding: 10px 14px; border-top: 1px solid #f2f2f2; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12.5px; white-space: pre-wrap; background: #f9fafb; }

.composer { display: flex; gap: 10px; align-items: flex-end; padding: 14px 20px; border-top: 1px solid #ececec; background: #fff; }
.composer textarea { flex: 1; resize: none; border: 1px solid #e2e2e2; border-radius: 12px; padding: 12px 14px; font: inherit; font-size: 15px; max-height: 160px; }
.composer textarea:focus { outline: none; border-color: #b9c0c8; }
.send { background: #1f2328; color: #fff; border: none; border-radius: 12px; padding: 11px 20px; font-size: 15px; cursor: pointer; }
.send:disabled { background: #c9cdd2; cursor: not-allowed; }

/* how-it-works overlay */
.help-overlay { position: fixed; inset: 0; z-index: 50; background: rgba(20,22,26,0.45); display: flex; align-items: flex-start; justify-content: center; padding: 5vh 16px; overflow-y: auto; }
.help-card { position: relative; width: 100%; max-width: 720px; background: #fff; border-radius: 16px; padding: 28px 30px 30px; box-shadow: 0 14px 44px rgba(0,0,0,0.2); }
.help-close { position: absolute; top: 12px; right: 14px; border: none; background: transparent; font-size: 26px; line-height: 1; color: #8a8f98; cursor: pointer; }
.help-close:hover { color: #1f2328; }
.help-title { margin: 0 0 10px; font-size: 22px; font-weight: 700; }
.help-lede { margin: 0 0 20px; color: #3a3f45; line-height: 1.6; font-size: 15px; }
.help-lede em { font-style: normal; color: #1d4ed8; font-weight: 600; }
.diagram { background: #fbfcfe; border: 1px solid #eef0f3; border-radius: 12px; padding: 14px 10px 6px; margin-bottom: 22px; }
.diagram svg { display: block; width: 100%; height: auto; }
.help-steps { list-style: none; margin: 0 0 20px; padding: 0; display: flex; flex-direction: column; gap: 14px; }
.help-steps li { display: flex; gap: 12px; align-items: flex-start; font-size: 14.5px; line-height: 1.55; color: #2a2f36; }
.help-steps .n { flex: 0 0 auto; width: 24px; height: 24px; margin-top: 1px; border-radius: 999px; background: #eef4ff; color: #1d4ed8; font-size: 13px; font-weight: 700; display: flex; align-items: center; justify-content: center; }
.help-why-title { margin: 0 0 10px; font-size: 14px; font-weight: 650; color: #2a2f36; }
.help-why { margin: 0 0 18px; padding: 0; list-style: none; display: flex; flex-direction: column; gap: 8px; }
.help-why li { position: relative; padding-left: 18px; font-size: 14px; line-height: 1.5; color: #2a2f36; }
.help-why li::before { content: "→"; position: absolute; left: 0; color: #1d4ed8; }
.help-refs { margin: 14px 0 0; font-size: 12.5px; color: #8a8f98; }
.help-refs a { color: #1d4ed8; text-decoration: none; }
.help-refs a:hover { text-decoration: underline; }

/* access-token gate */
.gate { min-height: 100vh; display: flex; align-items: center; justify-content: center; background: #f4f4f5; padding: 20px; }
.gate-card { width: 100%; max-width: 540px; background: #fff; border-radius: 16px; padding: 44px 40px; box-shadow: 0 1px 3px rgba(0,0,0,0.04), 0 10px 34px rgba(0,0,0,0.05); text-align: center; }
.gate-title { margin: 0 0 10px; font-size: 28px; font-weight: 800; color: #1f2328; }
.gate-sub { margin: 0 0 26px; color: #6b7280; font-size: 16px; }
.gate-input { width: 100%; border: 1px solid #e2e2e2; border-radius: 10px; padding: 13px 15px; font-size: 15px; margin-bottom: 14px; }
.gate-input:focus { outline: none; border-color: #b9c0c8; }
.gate-btn { width: 100%; border: none; border-radius: 10px; padding: 13px; font-size: 15px; font-weight: 700; color: #fff; background: #1f2328; cursor: pointer; }
.gate-btn:disabled { background: #8a8f98; cursor: not-allowed; }
.gate-err { margin: 14px 0 0; color: #b42318; font-size: 14px; }
</style>
