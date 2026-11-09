// AI Code Executor API, an LLM agent whose tool is a sandbox.
//
// The model is given one tool: it runs code in the fast Wasm interpreter. The
// model writes the code, we execute it through @spinframework/sandbox and feed
// the result back. The full transcript (reasoning + each tool call + output +
// answer) is streamed to the UI. The LLM provider API format (Anthropic or OpenAI)
// is chosen at build time; see build.mjs. Within that, the UI runs two independent
// conversations side by side, each pinned to a model id of the caller's choice (from
// the list GET /api/models reports); the chosen model id is streamed back to the UI
// so it can tag the response with it.

import { Hono } from "hono";
import { fire } from "hono/service-worker";
import { getCookie, setCookie } from "hono/cookie";
import type { Context } from "hono";
import * as variables from "@spinframework/spin-variables";
import { createProvider, listModels } from "#llm-provider";

import { Interpreter, type Language } from "@spinframework/sandbox/interpreter";
import type { HttpInput } from "@spinframework/sandbox/core";
import { interpreterTool } from "@spinframework/sandbox/tools";
import { historyFor, type History, type ToolResult } from "./llm/types";
import { log, initLogger } from "./logger";

const INTERPRETER_TOOL = interpreterTool({ languages: ["javascript"] });

function systemPrompt(): string {
  return (
    "You are an AI code executor. When the user asks you to compute something, write the code and " +
    "RUN it in a sandbox using your tool, never compute by hand. After running, give a short, direct answer " +
    "with the result. Keep code minimal and print the result to stdout. " +
    "You have one sandbox: a fast Wasm interpreter. Use it for all code execution."
  );
}

type WireEvent =
  // Which model this turn's conversation is running on (the pinned one, or the provider's
  // default), sent once before any other event so the UI can tag the response with it.
  | { t: "model"; model: string }
  // An incremental slice of the model's text, streamed as it is generated.
  // `block` groups the deltas of one text block (unique within an assistant turn).
  | { t: "text_delta"; block: string; text: string }
  | {
      t: "tool_start";
      id: number;
      language: string;
      code: string;
      // Extra npm packages the model asked to bundle in (name -> semver), and the outbound
      // hosts it allow-listed for this run, shown in the UI alongside the code.
      packages?: Record<string, string>;
      allowedHosts?: string[];
      genMs: number;
    }
  | { t: "tool_end"; id: number; execMs: number; stdout: string; stderr: string; error: string | null }
  // Token usage summed across every model turn it took to answer this one prompt (an
  // agentic run can take several turns when the model calls the tool more than once).
  | { t: "done"; history: History; usage: { input: number; output: number } }
  | { t: "error"; error: string };

type Emit = (e: WireEvent) => void;

function clip(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + "…" : s;
}

function formatToolResult(stdout: string, stderr: string, error: string | null): string {
  const parts: string[] = [];
  if (stdout) parts.push("stdout:\n" + stdout);
  if (stderr) parts.push("stderr:\n" + stderr);
  if (error) parts.push("error: " + error);
  return parts.join("\n\n") || "(no output)";
}

// Runs the agentic loop, emitting each step as soon as it is available so the UI
// can render turn by turn (the code the moment the model writes it, then the
// output the moment the sandbox returns) instead of waiting for the whole
// transcript.
async function runAgent(prompt: string, history: unknown, emit: Emit, pinnedModel?: string): Promise<void> {
  const llm = createProvider(pinnedModel);
  emit({ t: "model", model: llm.model });
  const tsUrl = variables.get("ts_interpreter_url") ?? "http://ts-sandbox.spin.internal";
  const pyUrl = variables.get("py_interpreter_url") ?? "http://py-sandbox.spin.internal";
  const bundlerUrl = variables.get("bundler_url") ?? "http://bundler.spin.internal";

  // The interpreter is two private, service-chained components, one per language, so pick
  // the client by the language the model chose. The JS interpreter also knows the bundler, so
  // model code can pull extra npm dependencies (see the tool's `dependencies` field).
  const interpreters: Record<Language, Interpreter> = {
    javascript: Interpreter.javascript({ baseUrl: tsUrl, bundlerUrl }),
    python: Interpreter.python({ baseUrl: pyUrl }),
  };

  log.info(`chat: provider=${llm.name} model=${llm.model} prompt=${JSON.stringify(clip(prompt, 80))}`);

  // Continue the conversation: prior turns + the new user message.
  const messages = historyFor(llm, history);
  messages.push(llm.userMessage(prompt));
  let totalInput = 0;
  let totalOutput = 0;
  const done = () =>
    emit({ t: "done", history: { provider: llm.name, items: messages }, usage: { input: totalInput, output: totalOutput } });
  let toolId = 0;

  // Agentic loop: let the model call the sandbox tool until it produces a final answer.
  for (let turn = 0; turn < 8; turn++) {
    // Time the model "generating the code" (the latency of this model turn).
    const genStart = Date.now();
    // Stream the turn so the model's text appears token-by-token as it is
    // produced, instead of arriving in one buffered blob at the end of the turn.
    const res = await llm.turn(
      messages,
      { system: systemPrompt(), tools: [INTERPRETER_TOOL], maxTokens: 4096 },
      { onText: (block, text) => emit({ t: "text_delta", block: `${turn}-${block}`, text }) },
    );
    const genMs = Date.now() - genStart;
    totalInput += res.usage.input;
    totalOutput += res.usage.output;
    log.info(`generate: turn=${turn} ${genMs}ms stop=${res.stop} in=${res.usage.input} out=${res.usage.output}`);

    const toolResults: ToolResult[] = [];
    for (const call of res.toolCalls) {
      const input = call.input as {
        language: Language;
        code: string;
        dependencies?: Record<string, string>;
        allowedHosts?: string[];
        identity?: string;
        input?: HttpInput;
        kvEnabled?: boolean;
      };
      if ((input.language !== "python" && input.language !== "javascript") || typeof input.code !== "string") {
        toolResults.push({ id: call.id, content: "error: arguments must include language (python|javascript) and code", isError: true });
        continue;
      }
      const id = toolId++;

      // Stream the code the moment the model produces it (before it runs), along with the
      // extra packages and allow-listed hosts it requested, so the UI can show them.
      emit({
        t: "tool_start",
        id,
        language: input.language,
        code: input.code,
        packages: input.language === "javascript" ? input.dependencies : undefined,
        allowedHosts: Array.isArray(input.allowedHosts) && input.allowedHosts.length ? input.allowedHosts : undefined,
        genMs,
      });

      let stdout = "";
      let stderr = "";
      let error: string | null = null;
      let execMs = 0;
      try {
        const t = Date.now();
        // The model picks `identity`, and it becomes the sandbox id as-is, so every
        // conversation (or prompt-injected content) naming the same identity shares the
        // same KV data. That is fine for this single-user demo. A multi-user app should
        // prefix it with a scope it controls, length-prefixed so no two (scope, identity)
        // pairs produce the same id, e.g.
        // `input.identity ? `${userId.length}:${userId}:${input.identity}` : undefined`
        // (runs without an identity already get a fresh random id). KV keys are
        // namespaced per sandbox id, so distinct scopes never see each other's data.
        const runOpts = {
          allowedHosts: Array.isArray(input.allowedHosts) ? input.allowedHosts : [],
          identity: input.identity,
          kvEnabled: input.kvEnabled ?? false,
          packageJson:
            input.language === "javascript" && input.dependencies && Object.keys(input.dependencies).length
              ? { dependencies: input.dependencies }
              : undefined,
        };
        if (input.input) {
          const response = await interpreters[input.language].runHandler(input.code, input.input, runOpts);
          stdout = `HTTP ${response.status}\n${await response.text()}`;
        } else {
          const r = await interpreters[input.language].execute(input.code, runOpts);
          stdout = r.stdout;
          stderr = r.stderr;
          error = r.error ? `${r.error.name}: ${r.error.value}` : null;
        }
        execMs = Date.now() - t;
      } catch (e: any) {
        error = `sandbox error: ${String(e?.message ?? e)}`;
      }
      log.info(
        `execute: sandbox=wasm_interpreter lang=${input.language} exec=${execMs}ms ` +
        `${error ? "error=" + JSON.stringify(error) : "ok"} stdout=${stdout.length}b`,
      );

      // Stream the output the moment the sandbox returns.
      emit({ t: "tool_end", id, execMs, stdout, stderr, error });
      toolResults.push({ id: call.id, content: formatToolResult(stdout, stderr, error), isError: error !== null });
    }

    if (res.toolCalls.length === 0) {
      // Return the full updated history so the next turn continues the conversation.
      done();
      return;
    }
    messages.push(...llm.toolResults(toolResults));
  }
  done();
}

const app = new Hono();

app.use(async (c: Context, next) => {
  initLogger();
  c.header("server", "ai-code-executor");
  await next();
});

// ---- access-token gate ----
// `access_token` is a required Spin variable (see spin.toml), so every deployment sets one:
// every route except health/auth requires a matching `app_token` cookie (set by
// POST /api/auth). The empty-string check below is a defense-in-depth fallback only (e.g. if
// it were ever explicitly set to ""), not the expected path.
const AUTH_COOKIE = "app_token";
const accessToken = () => (variables.get("access_token") ?? "").trim();

app.use(async (c: Context, next) => {
  const path = new URL(c.req.url).pathname;
  if (path === "/api/health" || path === "/api/auth") return next();
  const token = accessToken();
  if (token && getCookie(c, AUTH_COOKIE) !== token) return c.text("Unauthorized", 401);
  return next();
});

// Only this origin's own pages may call the API. Browsers send `Origin` on every cross-origin
// request and on same-origin writes, so this stops other sites driving the model, gate or not.
app.use("/api/*", async (c: Context, next) => {
  const origin = c.req.header("origin");
  if (origin !== undefined && !isSameHost(origin, c.req.url)) return c.json({ error: "forbidden" }, 403);
  return next();
});

function isSameHost(origin: string, requestUrl: string): boolean {
  try {
    // Compare hosts, not schemes: behind a TLS-terminating proxy the request URL is http.
    return new URL(origin).host === new URL(requestUrl).host;
  } catch {
    return false; // "null" (sandboxed page) or garbage
  }
}

function isHttps(c: Context): boolean {
  return new URL(c.req.url).protocol === "https:" || c.req.header("x-forwarded-proto") === "https";
}

app.get("/api/health", (c: Context) => {
  const token = accessToken();
  const llm = createProvider();
  return c.json({
    ok: true,
    provider: llm.name,
    model: llm.model,
    authRequired: token !== "",
    authed: token === "" || getCookie(c, AUTH_COOKIE) === token,
  });
});

// Lists the models the configured server can serve, so the UI can populate a picker
// instead of hardcoding ids.
app.get("/api/models", async (c: Context) => {
  try {
    const models = await listModels();
    return c.json({ models });
  } catch (e: any) {
    log.error(`models: ${e?.stack ?? e}`);
    return c.json({ error: "could not list models" }, 502);
  }
});

// Validate the access token and, on success, set the gate cookie.
app.post("/api/auth", async (c: Context) => {
  const token = accessToken();
  if (!token) return c.json({ ok: true }); // gate disabled
  let given = "";
  try {
    given = ((await c.req.json<{ token?: string }>()).token ?? "").trim();
  } catch {
    /* fall through to 401 */
  }
  if (given && given === token) {
    // HttpOnly: page scripts cannot read it. Secure over HTTPS only, so http://localhost works.
    setCookie(c, AUTH_COOKIE, token, {
      path: "/",
      httpOnly: true,
      secure: isHttps(c),
      sameSite: "Lax",
      maxAge: 60 * 60 * 24 * 30,
    });
    return c.json({ ok: true });
  }
  return c.json({ ok: false, error: "invalid access token" }, 401);
});

app.post("/api/chat", async (c: Context) => {
  if (!accessToken()) {
    log.warn("access_token is empty: anyone who can reach this app can use the model key");
  }
  let prompt = "";
  let history: unknown = null;
  let pinnedModel: string | undefined;
  try {
    const body = await c.req.json<{ prompt?: string; history?: unknown; model?: string }>();
    prompt = (body.prompt ?? "").trim();
    history = body.history ?? null;
    // The split-screen UI pins each side to a model id it got from GET /api/models, so the
    // same prompt runs on both, independently, for a direct comparison. Without one, the
    // provider falls back to its own default, which keeps the endpoint usable for direct
    // API callers that only want one answer.
    const requestedModel = typeof body.model === "string" ? body.model.trim() : "";
    pinnedModel = requestedModel || undefined;
  } catch {
    return c.json({ error: "expected JSON body { prompt: string }" }, 400);
  }
  if (!prompt) return c.json({ error: "prompt is required" }, 400);

  // Stream the transcript as newline-delimited JSON: each event is flushed as
  // soon as it is produced, so the browser renders turn by turn.
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const emit: Emit = (e) => controller.enqueue(encoder.encode(JSON.stringify(e) + "\n"));
      try {
        await runAgent(prompt, history, emit, pinnedModel);
      } catch (e: any) {
        log.error(`agent error: ${e?.stack ?? e}`);
        emit({ t: "error", error: String(e?.message ?? e) });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: { "content-type": "application/x-ndjson", "cache-control": "no-store" },
  });
});

// Without this, Hono re-fetches the request itself on any 404, which Spin blocks (500).
fire(app, { fetch: undefined });
