# AI Code Executor: an agent whose tool is a sandbox

A Spin application: an LLM (via the Anthropic Messages API by default, or the OpenAI Chat Completions API) writes
code and runs it in the fast Wasm interpreter
through [`@spinframework/sandbox`](../../sdk), with the transcript streamed
back to a chat UI.

```
      public routes                          private components (no public route)
┌──────────────┐  POST /api/chat  ┌─────────────────────┐  ts-sandbox.spin.internal  ┌─────────────┐
│  Nuxt SPA    │ ───────────────▶ │  api (Hono, Wasm)   │ ─────────────────────────▶ │  ts-sandbox │
│  /...        │ ◀─────────────── │  LLM tool loop      │  py-sandbox.spin.internal  │  py-sandbox │
└──────────────┘  NDJSON (live)   └─────────────────────┘ ─────────────────────────▶ └─────────────┘
```

The two interpreters (`ts-sandbox`, `py-sandbox`) are private components of this app
(`route = { private = true }`), so they have no public route and are reachable only
from the `api` component via local service chaining (`<component>.spin.internal`). A
private `bundler` component (experimental) packages any extra npm dependencies the model requests. The
API depends on the sandbox client from this repo ([`@spinframework/sandbox`](../../sdk),
a local `file:` dependency) and holds one `Interpreter` per language, each pointed at
its component's internal URL.

## How it works: the CodeAct pattern

This example is a concrete CodeAct agent: the model's action is code it writes and
runs, not a call into a fixed tool set. It reasons, emits a program, runs it in a
sandbox, observes the real output, and repeats until it can answer. That is the
standard agentic loop with dynamic code execution as the action. (Background:
[Why: CodeAct](../../README.md#why-codeact).)

1. You ask a question in the chat.
2. The model writes code. It picks Python or JavaScript and produces a small program,
   streamed into the UI as it is typed.
3. A private Wasm sandbox runs it. The code executes in an isolated WebAssembly
   interpreter (`ts-sandbox` / `py-sandbox`) with no filesystem, no shell, and
   default-deny egress. Because model-written code is untrusted, the sandbox is a
   private component reached only over internal service chaining, never a public
   endpoint.
4. The output loops back. stdout, stderr, and errors return to the model (the
   observation), which fixes and re-runs or, once satisfied, writes the final answer.

Why let the model write code instead of only calling fixed tools? The action space is
open-ended (anything the sandbox can run), control flow lives in one program instead of
N tool calls, and a real interpreter computes the answer instead of the model guessing.
The trade-off (untrusted generated code) is contained by the isolated private sandbox.
The whole loop streams live; the UI's "How it works" button shows the same flow as a
diagram.

## The tool

The model is given one tool and calls it per task (it shows up in the UI as a badge on
each step):

- **`run_in_wasm_interpreter`**: fast, lightweight, pre-bundled libs, no filesystem or
  shell. Each call runs through `Interpreter.run()`; the `{stdout, stderr, error}` is
  fed back to the model, which loops until it has an answer. For JavaScript the model
  may also list extra npm `dependencies`, which are bundled in before the run.

## Streaming + timing

`/api/chat` responds with a newline-delimited JSON (NDJSON) stream, not one buffered
blob: the server flushes each event the moment it is produced, so the UI renders turn
by turn.

- `{"t":"text_delta", block, text}`: a slice of the model's text, so the answer types
  out token by token (a blinking cursor marks the block still being written).
- `{"t":"tool_start", id, language, code, genMs}`: the code, the moment the model
  writes it (the card appears with "running…").
- `{"t":"tool_end", id, execMs, stdout, stderr, error}`: the output, the moment the
  sandbox returns (`genMs` is the model turn latency that produced the code, `execMs`
  the interpreter run).
- `{"t":"model", model}`: the model id this run is pinned to (or the provider's default),
  sent once before anything else.
- `{"t":"done", history, usage}` / `{"t":"error"}`. `history` is the provider-tagged
  conversation the UI sends back to continue it; `usage` is `{input, output}` token
  counts summed across every model turn it took to answer the prompt (an agentic run can
  take more than one turn when the model calls the tool more than once).

Each tool card shows "generated in" (`genMs`) and "ran in" (`execMs`); each assistant
answer shows its token usage, and each pane header a running total for the conversation.
Spin/StarlingMonkey forwards a guest streaming body chunk by chunk, which is what makes
the incremental flush work.

### Markdown + syntax highlighting

The model's text is rendered as Markdown with
[markdown-it](https://github.com/markdown-it/markdown-it) and every code block is
syntax-highlighted with [highlight.js](https://highlightjs.org/), incrementally as the
text streams in. Because the HTML comes from model output it is treated as untrusted:
`html: false` (raw HTML escaped), dangerous link schemes rejected, and a fenced block's
language is only echoed into the DOM when it matches a registered highlight.js
language.

## Choosing the LLM provider

The provider is fixed at build time with a [Spin build
profile](https://spinframework.dev/v4/build#building-with-profiles), so only its SDK is
bundled into the `api` component:

| Build | Provider | API |
|---|---|---|
| default (no profile) | Anthropic, `api/dist/api-anthropic.wasm` | Messages API |
| `--profile openai` | OpenAI, `api/dist/api-openai.wasm` | Chat Completions API (stateless) |

Both builds share one agent loop; the provider code lives in [`api/src/llm/`](api/src/llm).
Both builds read the same variables: the profile picks the API format, `model_base_url`
picks the server. It is also the `api` component's outbound allow-list entry, so either
build can target any compatible server.

### Comparing models side by side

Within that one provider build, the UI runs an A/B comparison across 1-2 models,
chosen with the "Compare" buttons. `GET /api/models` reports the model ids the server
behind `model_base_url` actually serves (via each provider's `listModels()` in
[`api/src/llm/`](api/src/llm)), and `ui/pages/index.vue` shows one dropdown per pane,
populated from that list, so you pick which models to compare. Every prompt is sent to
`/api/chat` once per pane in parallel, each pinned to that pane's chosen model (the
`model` field in the request body), and rendered as independent, labeled, side-by-side
panes with their own conversation history. Changing the pane count starts a fresh
comparison (there is no sane way to carry an old conversation across a different number
of panes). A request without a `model` falls back to a hardcoded default in
[`api/src/llm/`](api/src/llm) (`claude-opus-4-8` or `gpt-5`), which keeps the endpoint
usable for direct API callers that only want one answer.

## Configuration (Spin application variables)

| Variable | Default | Notes |
|---|---|---|
| `model_base_url` | (required) | origin (no path) of the model server, `SPIN_VARIABLE_MODEL_BASE_URL=<model-base-url>`; also the `api` component's outbound allow-list entry |
| `model_api_key` | empty (secret) | `SPIN_VARIABLE_MODEL_API_KEY=<api-key>`, the key for the model server |
| `ts_interpreter_url` | `http://ts-sandbox.spin.internal` | the private JS/TS interpreter component |
| `py_interpreter_url` | `http://py-sandbox.spin.internal` | the private Python interpreter component |
| `bundler_url` | `http://bundler.spin.internal` | the private experimental bundler component |
| `log_level` | `info` | `error`, `warn`, `info`, `debug`, or `trace` |
| `access_token` | (required, secret) | `SPIN_VARIABLE_ACCESS_TOKEN=<secret>`; gates the UI + API behind an access-token page. Required so the app can't start open to anyone who can reach it |
| `esm_base_url` | `https://esm.sh` | origin of the esm.sh server used by the experimental bundler for the model's npm `dependencies`; point it at a [self-hosted instance](https://github.com/esm-dev/esm.sh/blob/main/HOSTING.md) if you prefer |

The interpreter URLs default to service chaining, so nothing needs to run separately;
the interpreters are built and served as part of this app. Override them only to point
at an external sandbox instead.

## Run it

Everything is one app, with no separate interpreter to start.

1. Build: `spin build` (add `--profile openai` for the OpenAI build) builds all five components: the API (esbuild + `j2w`), the UI
   (`nuxt generate`), the two private interpreters, and the private bundler (this
   repo's components, built in place from `../../`).
2. Run (the model server, key, and access token come from the environment; `access_token`
   is required, so `spin up` fails fast without it):
   ```bash
   export SPIN_VARIABLE_MODEL_BASE_URL=<model-base-url> SPIN_VARIABLE_MODEL_API_KEY=<api-key>
   export SPIN_VARIABLE_ACCESS_TOKEN=<secret>
   spin up                    # Anthropic Messages API
   spin up --profile openai   # OpenAI Chat Completions API
   ```
   Build and run a profile together with `spin up --profile openai --build`, so a stale
   build of the other profile is never served.
3. Open the served URL and click a prompt, e.g. "What is the factorial of 15?". The
   model writes Python/JS and runs it in the matching private interpreter, then
   answers.

### Local models with Ollama

[Ollama](https://ollama.com) serves both the
[Anthropic](https://docs.ollama.com/api/anthropic-compatibility) and
[OpenAI Chat Completions](https://docs.ollama.com/api/openai-compatibility) APIs locally and
ignores the API key, so either build runs without a cloud account:

```bash
ollama pull qwen3:4b
export SPIN_VARIABLE_MODEL_BASE_URL=http://localhost:11434
export SPIN_VARIABLE_ACCESS_TOKEN=<secret>
spin up --build                    # Anthropic Messages API
spin up --profile openai --build   # OpenAI Chat Completions API
```

Pick `qwen3:4b` from the model dropdown in the UI (populated from Ollama's own model
list via `GET /api/models`).

Small local models are slower and less reliable at multi-step tool use than hosted
ones.

## Security: read before deploying

The model's code runs in the private interpreters with no network access unless the
model lists hosts in `allowedHosts`, and no storage unless it sets `kvEnabled`. The api
sets the access cookie `HttpOnly` (and `Secure` over HTTPS) and rejects `/api/*`
requests from other origins. Before deploying:

1. `access_token` is a required variable, so the app refuses to start without one — pick a
   long random secret for `SPIN_VARIABLE_ACCESS_TOKEN` in any environment others can reach.
2. Block private networks at the host. The guard refuses private IP literals and
   internal names, but an allowed hostname that resolves to a private or loopback
   address (for example `127.0.0.1.nip.io`) still connects. With Spin, pass a runtime
   config:
   ```toml
   # runtime-config.toml: spin up --runtime-config-file runtime-config.toml
   [outbound_networking]
   block_networks = ["private"]
   ```
   This applies to the whole app, so it also blocks a model server on `localhost` or a
   private address; use it with a remote model.
3. The model chooses `identity`, so runs that name the same identity share key-value
   data. For more than one user, have the api prefix it with a length-prefixed user
   scope (`${userId.length}:${userId}:${identity}`) before running the code.

## Layout

```
spin.toml          wires 5 components: public ui + api, private ts-sandbox + py-sandbox + bundler
api/               Hono component: the LLM tool-use loop + the interpreter tool
  src/index.ts     the agent; imports @spinframework/sandbox; one Interpreter client per component
  src/llm/         provider interface + Anthropic and OpenAI implementations (one bundled per build)
ui/                Nuxt SPA chat (near-verbatim from upstream; one filesystem prompt swapped)
  pages/index.vue  the chat UI
../../packages/typescript/sandbox   private JS/TS interpreter, built in place, reached via ts-sandbox.spin.internal
../../py-sandbox   private Python interpreter, built in place, reached via py-sandbox.spin.internal
../../packages/typescript/bundler   experimental private npm bundler, built in place, reached via bundler.spin.internal
```
