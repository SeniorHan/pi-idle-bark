/**
 * pi-idle-bark — presence-aware Bark notifications for Pi
 *
 * Unlike Bark extensions that push on every settle (spamming while you sit at
 * the terminal), pi-idle-bark only reaches your iPhone when the session has
 * actually been waiting for you beyond a threshold. If you are at the desk and
 * keep the conversation moving, it stays completely silent.
 *
 * - Fires after `thresholdMinutes` (default 5) with no input after the agent
 *   settles or a blocking prompt opens (including ask_user_question dialogs).
 * - Any new input cancels the pending alert instantly.
 * - Still away? Re-pings with exponential backoff (default 5m, ×2, capped at
 *   1h, unlimited repeats — all configurable).
 * - Aborted runs (Escape) never notify: you just pressed a key.
 * - Optional `smart` mode: an in-process Pi sub-session (your default model,
 *   or a configured `provider/modelId`) reads the last few assistant messages
 *   and writes a short humanized push. One call per waiting period; repeats
 *   reuse the cached text. Falls back to the plain template on any failure.
 * - Zero dependencies; failures to push are swallowed silently.
 *
 * Configuration: `$PI_CODING_AGENT_DIR/idle-bark.json` (normally
 * `~/.pi/agent/idle-bark.json`). See README for all fields.
 */

import { appendFileSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

interface SmartConfig {
  enabled?: boolean;
  /** "provider/modelId" — omit to use the Pi default model. */
  model?: string;
  /** "model" (default): the sub-session also writes the title. "fixed": title stays "⏳ Pi is waiting". */
  titleMode?: "model" | "fixed";
  /** Full custom prompt replacing the built-in instruction block (context is still appended). */
  prompt?: string;
  /** "cached" (default): repeats reuse the first crafted text; "regenerate": re-run the model per repeat; "template": repeats fall back to the plain template. */
  repeatMode?: "cached" | "regenerate" | "template";
  /** How many recent assistant messages to feed the model. Default 2. */
  contextMessages?: number;
  /** Per-message truncation. Default 800 chars. */
  contextChars?: number;
  /** Include cwd/wait-time/pending-question metadata. Default true. */
  includeMeta?: boolean;
  /** "auto" (match message language) or an ISO code like "zh" / "en". */
  language?: string;
  /** Sub-session thinking level. Default "low". */
  thinkingLevel?: "off" | "minimal" | "low" | "medium" | "high";
  /** Give up and fall back to the template after this long. Default 30s. */
  timeoutMs?: number;
}

interface RepeatConfig {
  /** "exponential" (default): gaps grow ×factor up to capMinutes. "fixed": constant baseMinutes gaps. */
  strategy?: "exponential" | "fixed";
  /** First gap in minutes. Default 5. */
  baseMinutes?: number;
  /** Multiplier between repeats (exponential only). Default 2. */
  factor?: number;
  /** Gap ceiling in minutes (exponential only). Default 60. */
  capMinutes?: number;
  /** Total repeat limit. Default 5. 0 = unlimited. */
  maxRepeats?: number;
}

interface IdleBarkConfig {
  enabled?: boolean;
  endpoint?: string;
  deviceKey?: string;
  thresholdMinutes?: number;
  /** Legacy fixed-repeat keys; ignored when `repeat` is present. */
  repeatMinutes?: number;
  maxRepeats?: number;
  repeat?: RepeatConfig;
  smart?: SmartConfig;
  params?: Record<string, unknown>;
}

const DEFAULTS = {
  endpoint: "https://api.day.app",
  thresholdMinutes: 5,
  repeatMinutes: 30,
  maxRepeats: 3,
  backoff: { baseMinutes: 5, factor: 2, capMinutes: 60, maxRepeats: 5 },
  params: { group: "pi", level: "timeSensitive" },
};

function loadConfig(): IdleBarkConfig {
  const agentDir =
    process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
  try {
    return JSON.parse(
      readFileSync(join(agentDir, "idle-bark.json"), "utf8"),
    ) as IdleBarkConfig;
  } catch {
    return {};
  }
}

/** Type-only marker so jiti strips the pi import at runtime for the config path. */
type SmartCraft = { title: string; body: string };

function dbg(msg: string) {
  if (!process.env.PI_IDLE_BARK_DEBUG) return;
  try {
    appendFileSync(
      join(homedir(), "idle-bark-debug.log"),
      new Date().toISOString() + " " + msg + "\n",
    );
  } catch {}
}

async function craftSmartNotification(
  messages: string[],
  meta: { cwd: string; waitedMs: number; questionPending: boolean; repeat?: number; total?: number },
  smart: {
    model?: string;
    prompt?: string;
    titleMode: "model" | "fixed";
    contextChars: number;
    includeMeta: boolean;
    language: string;
    thinkingLevel: SmartConfig["thinkingLevel"];
    timeoutMs: number;
  },
): Promise<SmartCraft | null> {
  // The sub-session is a normal Pi session in this same process. Mark it so
  // this extension (and any copy of it) stays dormant inside that session.
  const prev = process.env.PI_IDLE_BARK_CHILD;
  process.env.PI_IDLE_BARK_CHILD = "1";
  try {
    const pkg = await import("@earendil-works/pi-coding-agent");
    const { createAgentSession, SessionManager, SettingsManager, ModelRuntime } = pkg;

    const agentDir =
      process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");

    const sessionOptions: Record<string, unknown> = {
      cwd: meta.cwd,
      agentDir,
      sessionManager: SessionManager.inMemory(meta.cwd),
      settingsManager: SettingsManager.create(meta.cwd, agentDir),
      noTools: "all",
      thinkingLevel: smart.thinkingLevel,
    };
    if (smart.model) {
      const [providerId, ...rest] = smart.model.split("/");
      const modelId = rest.join("/");
      const runtime = await ModelRuntime.create();
      const model = runtime.getModel(providerId, modelId);
      if (!model) throw new Error(`model not found: ${smart.model}`);
      sessionOptions.model = model;
    }

    const { session } = await createAgentSession(sessionOptions as never);
    try {
      const truncated = messages.map((m) =>
        m.length > smart.contextChars ? m.slice(0, smart.contextChars) + "…" : m,
      );
      const builtIn = [
        "You write push notifications for a coding agent on the user's phone. The agent session has been idle, waiting for the user to come back. Based on the context below, write the notification.",
        smart.titleMode === "model"
          ? "Output EXACTLY two lines: line 1 = title (max 16 chars, no quotes), line 2 = body (max 60 chars). No other output."
          : "Output EXACTLY one line: the body (max 60 chars). No other output.",
        `Language: ${
          smart.language === "auto"
            ? "match the language of the messages below"
            : smart.language
        }.`,
        "Tone: lightly humorous and playful, but still useful — say what just finished or what decision is pending. No emojis, no exclamation marks, no filler like \"please come back\".",
        "You have full creative freedom to vary the tone between reminders, Duolingo-streak-nagging style: playful guilt-tripping, escalating reluctance or urgency, never repetitive. Early reminders can claim the task \"will only be said once\"; later ones may sigh, bargain, or issue a dramatic ultimatum on the final reminder. Use the reminder index in the context below to escalate.",
      ];
      const parts: string[] = smart.prompt ? [smart.prompt] : builtIn;
      if (smart.includeMeta) {
        const mins = Math.max(1, Math.round(meta.waitedMs / 60_000));
        const reminder =
          meta.total > 0
            ? `this is reminder #${(meta.repeat ?? 0) + 1} of ${meta.total}${
                (meta.repeat ?? 0) + 1 >= meta.total ? " — the FINAL one, go dramatic if you like" : ""
              }`
            : `this is reminder #${(meta.repeat ?? 0) + 1} (there may be more)`;
        parts.push(
          `Context: waited ${mins}m in ${meta.cwd}${
            meta.questionPending ? "; the agent asked a blocking question that is still unanswered" : ""
          }; ${reminder}.`,
        );
      }
      parts.push(
        `Recent assistant messages (oldest first):\n${truncated
          .map((m, i) => `--- message ${i + 1} ---\n${m}`)
          .join("\n")}`,
      );

      // PromptOptions has no abort support: race a timer and let the
      // finally-block dispose() below tear the session down on timeout.
      const finished = await Promise.race([
        session.prompt(parts.join("\n\n")).then(
          () => "done" as const,
          () => "error" as const,
        ),
        new Promise<"timeout">((resolve) => {
          setTimeout(() => resolve("timeout"), smart.timeoutMs);
        }),
      ]);
      if (finished !== "done") {
        dbg(`sub-session ${finished} after ${smart.timeoutMs}ms`);
        return null;
      }

      // Extract the last assistant text from the finished session.
      const msgs = (session as unknown as { messages: Array<Record<string, unknown>> }).messages;
      let text = "";
      for (let i = msgs.length - 1; i >= 0; i--) {
        const m = msgs[i];
        if (m?.role !== "assistant") continue;
        const c = m.content;
        const t =
          typeof c === "string"
            ? c
            : Array.isArray(c)
              ? (c as Array<{ type?: string; text?: string }>)
                  .filter((p) => p?.type === "text")
                  .map((p) => p.text || "")
                  .join("")
              : "";
        if (t.trim()) {
          text = t.trim();
          break;
        }
      }
      const lines = text
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean);
      if (smart.titleMode === "model") {
        let title = "";
        let body = "";
        if (lines.length >= 2) {
          [title, body] = [lines[0], lines[1]];
        } else if (lines.length === 1) {
          // Models sometimes merge both parts into one line. Split on the
          // first separator; fall back to using it as the body alone.
          const one = lines[0];
          const mSplit = one.match(/^(.{2,20}?)[：:](.+)$/);
          if (mSplit) [title, body] = [mSplit[1], mSplit[2]];
          else body = one;
        }
        if (body) {
          const result = {
            title: (title || "⏳ Pi is waiting").slice(0, 40),
            body: body.slice(0, 120),
          };
          dbg(`craft ok: ${JSON.stringify(result)}`);
          return result;
        }
        dbg(`parse fail: ${lines.length} lines, raw=${text.slice(0, 120)}`);
        return null;
      }
      if (lines.length >= 1) {
        const result = { title: "", body: lines[0].slice(0, 120) };
        dbg(`craft ok (body only): ${JSON.stringify(result)}`);
        return result;
      }
      dbg(`parse fail: empty output`);
      return null;
    } finally {
      session.dispose();
    }
  } catch (err) {
    // Any failure (import, model resolution, timeout, parse) → template.
    if (process.env.PI_IDLE_BARK_DEBUG) {
      const msg = `[idle-bark] smart craft failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`;
      console.error(msg);
      try {
        appendFileSync(join(homedir(), "idle-bark-debug.log"), new Date().toISOString() + " " + msg + "\n");
      } catch {}
    }
    return null;
  } finally {
    if (prev === undefined) delete process.env.PI_IDLE_BARK_CHILD;
    else process.env.PI_IDLE_BARK_CHILD = prev;
  }
}

export default function (pi: ExtensionAPI) {
  // Sub-sessions spawned for smart notifications never install the extension.
  if (process.env.PI_IDLE_BARK_CHILD) return;

  const config = loadConfig();

  const enabledRaw = process.env.PI_IDLE_BARK_ENABLED ?? config.enabled ?? true;
  const enabled = String(enabledRaw).toLowerCase() !== "false";
  if (!enabled) return;

  const endpoint = process.env.PI_IDLE_BARK_ENDPOINT ?? config.endpoint ?? DEFAULTS.endpoint;
  const deviceKey = process.env.PI_IDLE_BARK_KEY ?? config.deviceKey;
  const thresholdMs =
    Number(process.env.PI_IDLE_BARK_MINUTES ?? config.thresholdMinutes ?? DEFAULTS.thresholdMinutes) * 60_000;
  const params = { ...DEFAULTS.params, ...config.params };

  // Repeat strategy: `repeat` config (or any PI_IDLE_BARK_REPEAT_* env) wins;
  // legacy top-level fixed keys (repeatMinutes/maxRepeats) map to "fixed".
  const repeatEnv =
    process.env.PI_IDLE_BARK_REPEAT_STRATEGY ??
    process.env.PI_IDLE_BARK_REPEAT_BASE_MINUTES ??
    process.env.PI_IDLE_BARK_REPEAT_FACTOR ??
    process.env.PI_IDLE_BARK_REPEAT_CAP_MINUTES ??
    process.env.PI_IDLE_BARK_REPEAT_MAX_REPEATS;
  const num = (v: string | number | undefined, d: number) =>
    Number.isFinite(Number(v)) ? Number(v) : d;
  const rcfg = config.repeat;
  const repeatGaps = config.repeat || repeatEnv
    ? {
        strategy: (String(
          process.env.PI_IDLE_BARK_REPEAT_STRATEGY ?? rcfg?.strategy ?? "exponential",
        ).toLowerCase() as "exponential" | "fixed"),
        first: num(process.env.PI_IDLE_BARK_REPEAT_BASE_MINUTES ?? rcfg?.baseMinutes, DEFAULTS.backoff.baseMinutes) * 60_000,
        factor: num(process.env.PI_IDLE_BARK_REPEAT_FACTOR ?? rcfg?.factor, DEFAULTS.backoff.factor),
        cap: num(process.env.PI_IDLE_BARK_REPEAT_CAP_MINUTES ?? rcfg?.capMinutes, DEFAULTS.backoff.capMinutes) * 60_000,
        maxRepeats: num(process.env.PI_IDLE_BARK_REPEAT_MAX_REPEATS ?? rcfg?.maxRepeats, DEFAULTS.backoff.maxRepeats),
      }
    : {
        strategy: "fixed" as const,
        first: num(process.env.PI_IDLE_BARK_REPEAT_MINUTES ?? config.repeatMinutes, DEFAULTS.repeatMinutes) * 60_000,
        factor: 1,
        cap: num(process.env.PI_IDLE_BARK_REPEAT_MINUTES ?? config.repeatMinutes, DEFAULTS.repeatMinutes) * 60_000,
        maxRepeats: num(process.env.PI_IDLE_BARK_MAX_REPEATS ?? config.maxRepeats, DEFAULTS.maxRepeats),
      };

  // Smart-notification settings.
  const smartEnabledRaw = process.env.PI_IDLE_BARK_SMART ?? config.smart?.enabled ?? false;
  const smartEnabled = String(smartEnabledRaw).toLowerCase() === "true";
  const smartModel = process.env.PI_IDLE_BARK_SMART_MODEL ?? config.smart?.model;
  const smartOpts = {
    model: smartModel,
    prompt: config.smart?.prompt,
    titleMode: (config.smart?.titleMode ?? "model") as "model" | "fixed",
    repeatMode: (config.smart?.repeatMode ?? "cached") as "cached" | "regenerate" | "template",
    contextMessages: Math.max(1, num(config.smart?.contextMessages, 2)),
    contextChars: Math.max(80, num(config.smart?.contextChars, 800)),
    includeMeta: String(config.smart?.includeMeta ?? true).toLowerCase() !== "false",
    language: config.smart?.language ?? "auto",
    thinkingLevel: (config.smart?.thinkingLevel ?? "low") as SmartConfig["thinkingLevel"],
    timeoutMs: Math.max(3_000, num(config.smart?.timeoutMs, 30_000)),
  };

  // Without a device key there is nothing to push to; stay dormant.
  if (!deviceKey) return;

  let timer: ReturnType<typeof setTimeout> | null = null;
  let repeatTimer: ReturnType<typeof setTimeout> | null = null;
  let repeats = 0;
  let recentAssistantTexts: string[] = []; // most recent last
  let questionPending = false;
  let waitingSince = 0;
  let craft: SmartCraft | null = null; // cached for this waiting period
  const totalReminders = repeatGaps.maxRepeats > 0 ? repeatGaps.maxRepeats + 1 : 0; // 0 = unlimited

  function cancel() {
    if (timer) clearTimeout(timer);
    if (repeatTimer) clearTimeout(repeatTimer);
    timer = null;
    repeatTimer = null;
    repeats = 0;
    craft = null;
  }

  async function push(title: string, body: string) {
    try {
      await fetch(`${endpoint}/${deviceKey}`, {
        method: "POST",
        headers: { "Content-Type": "application/json; charset=utf-8" },
        body: JSON.stringify({ title, body, ...params }),
      });
    } catch {
      // Bark unreachable: swallow, never disturb the session.
    }
  }

  function snippet() {
    const s = (recentAssistantTexts[recentAssistantTexts.length - 1] ?? "")
      .replace(/\s+/g, " ")
      .trim();
    return s.length > 140 ? s.slice(0, 140) + "…" : s;
  }

  function nextGapMs(): number {
    if (repeatGaps.strategy === "fixed") return repeatGaps.first;
    const raw = repeatGaps.first * Math.pow(repeatGaps.factor, Math.max(0, repeats));
    return Math.min(repeatGaps.cap, raw);
  }

  function waitLabel(): string {
    const mins = Math.round((Date.now() - waitingSince) / 60_000);
    return mins < 1 ? "<1m" : `${mins}m`;
  }

  async function templatePush(kind: "first" | "repeat") {
    const wait = waitLabel();
    if (kind === "first") {
      const tail = snippet();
      return push(
        "⏳ Pi is waiting",
        `No input for ${wait}` + (tail ? `: ${tail}` : " (a question may be pending)"),
      );
    }
    return push("⏳ Pi is still waiting", `No input for ${wait}`);
  }

  async function firstPush() {
    if (smartEnabled) {
      const context = recentAssistantTexts.slice(-smartOpts.contextMessages);
      craft = await craftSmartNotification(
        context,
        { cwd: process.cwd(), waitedMs: Date.now() - waitingSince, questionPending, repeat: 0, total: totalReminders },
        smartOpts,
      );
      if (craft) {
        return push(craft.title || "⏳ Pi is waiting", craft.body);
      }
    }
    await templatePush("first");
  }

  async function repeatPush() {
    // Repeats: cached text (context cannot change — no input), fresh model
    // call, or plain template — per smart.repeatMode.
    if (smartEnabled && craft && smartOpts.repeatMode === "regenerate") {
      const context = recentAssistantTexts.slice(-smartOpts.contextMessages);
      const fresh = await craftSmartNotification(
        context,
        { cwd: process.cwd(), waitedMs: Date.now() - waitingSince, questionPending, repeat: repeats, total: totalReminders },
        smartOpts,
      );
      if (fresh) {
        craft = fresh;
        return push(craft.title || "⏳ Pi is still waiting", craft.body);
      }
    }
    if (smartEnabled && craft && smartOpts.repeatMode === "cached") {
      return push("⏳ Pi is still waiting", `${craft.body} (waiting ${waitLabel()})`);
    }
    await templatePush("repeat");
  }

  function schedule() {
    cancel();
    waitingSince = Date.now();
    dbg(`schedule: threshold=${thresholdMs}ms backoff=${JSON.stringify(repeatGaps)} smart=${smartEnabled}`);
    timer = setTimeout(async () => {
      timer = null;
      await firstPush();
      const again = () => {
        if (repeatGaps.maxRepeats > 0 && repeats >= repeatGaps.maxRepeats) return;
        const gap = nextGapMs();
        dbg(`repeat scheduled in ${gap}ms (repeats=${repeats})`);
        repeatTimer = setTimeout(async () => {
          repeatTimer = null;
          repeats += 1;
          if (repeatGaps.maxRepeats > 0 && repeats > repeatGaps.maxRepeats) return;
          dbg(`repeat fired (repeats=${repeats}/${repeatGaps.maxRepeats} mode=${smartOpts.repeatMode})`);
          await repeatPush();
          again();
        }, nextGapMs());
      };
      again();
    }, thresholdMs);
  }

  // Track recent assistant texts so pushes carry useful context.
  pi.on("message_end", (event) => {
    const m = event.message as unknown as {
      role?: string;
      content?: string | Array<{ type?: string; text?: string }>;
    };
    if (m?.role !== "assistant") return;
    const c = m.content;
    const text =
      typeof c === "string"
        ? c
        : Array.isArray(c)
          ? c.filter((p) => p?.type === "text").map((p) => p.text || "").join("")
          : "";
    if (text.trim()) {
      recentAssistantTexts.push(text.trim());
      if (recentAssistantTexts.length > 8) recentAssistantTexts.shift();
    }
  });

  // Wait point 1: the agent fully settled and is waiting for input.
  pi.on("agent_settled", (event) => {
    if (event.aborted) return; // Escape was just pressed; user is present.
    questionPending = false;
    schedule();
  });

  // Wait point 2: a blocking user-facing prompt opened (ask dialogs included).
  pi.on("ui_prompt_start", () => {
    questionPending = true;
    schedule();
  });
  pi.on("ui_prompt_end", () => cancel());

  // Any new input or new run means the user came back.
  pi.on("input", () => cancel());
  pi.on("before_agent_start", () => cancel());
  pi.on("agent_start", () => cancel());

  pi.on("session_shutdown", () => cancel());
}
