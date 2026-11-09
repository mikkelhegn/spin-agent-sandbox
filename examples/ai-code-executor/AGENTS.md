# AGENTS.md: AI Code Executor example

A Spin app that puts an LLM tool-use loop in front of the Wasm code sandbox. See
[README.md](README.md) for the full picture; this covers the layout and the invariants.

## Components

Five components; only `ui` and `api` have public routes.

- **`api/`** (public `/api/...`): a Hono component (TypeScript to Wasm via esbuild +
  `j2w`). It runs the agent loop in [`api/src/index.ts`](api/src/index.ts): one tool
  (`run_in_wasm_interpreter`), the system prompt, and the streaming NDJSON protocol. It
  depends on the sandbox client [`@spinframework/sandbox`](../../sdk) (a local `file:`
  dependency in [`api/package.json`](api/package.json)) and holds one `Interpreter` per
  language, each pointed at a private interpreter component's `spin.internal` URL.
- **`ui/`** (public `/...`): a Nuxt SPA served by the Spin static fileserver. Adapted
  from the upstream example and trimmed to the interpreter-only surface (a
  filesystem-assuming prompt was swapped for an interpreter-friendly one).
- **`ts-sandbox` / `py-sandbox`** (private, `route = { private = true }`): this repo's
  interpreter components, built in place from `../../packages/typescript/sandbox` and `../../py-sandbox`.
  They have no public route and are reachable only from `api` via service chaining
  (`ts-sandbox.spin.internal` / `py-sandbox.spin.internal`), which the API lists in its
  `allowed_outbound_hosts`.
- **`bundler`** (private, experimental): packages extra npm dependencies for JavaScript runs. The SDK
  POSTs (source + package.json) to it and runs the returned self-contained bundle. It
  fetches from the esm.sh server named by `esm_base_url` (public esm.sh by default) and runs
  no user code, so it stays isolated from the
  code-executing sandboxes.

## Invariants

- **Streaming must stay incremental.** Every `emit()` is a flush point; don't buffer
  the transcript.
- **One provider per build.** `build.mjs` resolves `#llm-provider` to
  `src/llm/$LLM_PROVIDER.ts`; the agent loop only uses the `LlmProvider` interface in
  `src/llm/types.ts`. Keep provider SDK imports inside `src/llm/<provider>.ts`. Within
  that one provider, each `src/llm/<provider>.ts` also exports `listModels()`, used by
  `GET /api/models` to report the model ids the configured server actually serves; the UI
  populates each of its 1-2 panes' (user-chosen via "Compare" buttons) dropdowns from that
  list and pins its `/api/chat`
  request to the chosen id via `model` in the body, passed straight through to
  `createProvider(modelOverride)`. This is a model-id choice, not a second SDK/provider
  format. There is no `model` Spin variable: a missing or empty `model` in the request
  falls back to a hardcoded default in `createProvider` (`claude-opus-4-8` /
  `gpt-5`), not a configurable one.
- **Model output is untrusted.** The UI renders it with `html: false`, link-scheme
  allowlisting, and registered-language-only highlighting. Don't loosen that.
- **`access_token` is required, not optional.** It is `required = true` in `spin.toml`
  (no default), so `spin up`/deploy fails fast without `SPIN_VARIABLE_ACCESS_TOKEN` set,
  rather than silently serving an open instance. Don't reintroduce an empty default.

## Build and run

Self-contained: the interpreters are components of this app, so nothing runs
separately.

```bash
export SPIN_VARIABLE_MODEL_BASE_URL=<model-base-url> SPIN_VARIABLE_MODEL_API_KEY=<api-key>
export SPIN_VARIABLE_ACCESS_TOKEN=<secret>
spin up --build                    # Anthropic Messages API; builds all 5 components + serves
spin up --profile openai --build   # OpenAI Chat Completions API
```

`ts_interpreter_url` / `py_interpreter_url` default to the components' `spin.internal`
hosts. Override only to point the API at an external sandbox instead.
