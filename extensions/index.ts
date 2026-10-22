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
 * - Still away? Re-pings every `repeatMinutes` (default 30), up to `maxRepeats`.
 * - Aborted runs (Escape) never notify: you just pressed a key.
 * - Zero dependencies; failures to push are swallowed silently.
 *
 * Configuration: `$PI_CODING_AGENT_DIR/idle-bark.json` (normally
 * `~/.pi/agent/idle-bark.json`). See README for all fields.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

interface IdleBarkConfig {
  enabled?: boolean;
  endpoint?: string;
  deviceKey?: string;
  thresholdMinutes?: number;
  repeatMinutes?: number;
  maxRepeats?: number;
  params?: Record<string, unknown>;
}

const DEFAULTS = {
  endpoint: "https://api.day.app",
  thresholdMinutes: 5,
  repeatMinutes: 30,
  maxRepeats: 3,
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

export default function (pi: ExtensionAPI) {
  const config = loadConfig();

  const enabledRaw = process.env.PI_IDLE_BARK_ENABLED ?? config.enabled ?? true;
  const enabled = String(enabledRaw).toLowerCase() !== "false";
  if (!enabled) return;

  const endpoint = process.env.PI_IDLE_BARK_ENDPOINT ?? config.endpoint ?? DEFAULTS.endpoint;
  const deviceKey = process.env.PI_IDLE_BARK_KEY ?? config.deviceKey;
  const thresholdMs =
    Number(process.env.PI_IDLE_BARK_MINUTES ?? config.thresholdMinutes ?? DEFAULTS.thresholdMinutes) * 60_000;
  const repeatMs =
    Number(process.env.PI_IDLE_BARK_REPEAT_MINUTES ?? config.repeatMinutes ?? DEFAULTS.repeatMinutes) * 60_000;
  const maxRepeats = Number(
    process.env.PI_IDLE_BARK_MAX_REPEATS ?? config.maxRepeats ?? DEFAULTS.maxRepeats,
  );
  const params = { ...DEFAULTS.params, ...config.params };

  // Without a device key there is nothing to push to; stay dormant.
  if (!deviceKey) return;

  let timer: ReturnType<typeof setTimeout> | null = null;
  let repeatTimer: ReturnType<typeof setTimeout> | null = null;
  let repeats = 0;
  let lastAssistantText = "";
  let waitingSince = 0;

  function cancel() {
    if (timer) clearTimeout(timer);
    if (repeatTimer) clearTimeout(repeatTimer);
    timer = null;
    repeatTimer = null;
    repeats = 0;
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
    const s = lastAssistantText.replace(/\s+/g, " ").trim();
    return s.length > 140 ? s.slice(0, 140) + "…" : s;
  }

  function schedule() {
    cancel();
    waitingSince = Date.now();
    timer = setTimeout(async () => {
      timer = null;
      const mins = Math.round((Date.now() - waitingSince) / 60_000);
      const wait = mins < 1 ? "<1m" : `${mins}m`;
      const tail = snippet();
      await push(
        "⏳ Pi is waiting",
        `No input for ${wait}` + (tail ? `: ${tail}` : " (a question may be pending)"),
      );
      const again = () => {
        repeatTimer = setTimeout(async () => {
          repeatTimer = null;
          repeats += 1;
          if (repeats > maxRepeats) return;
          const m = Math.round((Date.now() - waitingSince) / 60_000);
          const w = m < 1 ? "<1m" : `${m}m`;
          await push("⏳ Pi is still waiting", `No input for ${w}`);
          again();
        }, repeatMs);
      };
      again();
    }, thresholdMs);
  }

  // Track the last assistant text so pushes carry a useful snippet.
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
    if (text.trim()) lastAssistantText = text.trim();
  });

  // Wait point 1: the agent fully settled and is waiting for input.
  pi.on("agent_settled", (event) => {
    if (event.aborted) return; // Escape was just pressed; user is present.
    schedule();
  });

  // Wait point 2: a blocking user-facing prompt opened (ask dialogs included).
  pi.on("ui_prompt_start", () => schedule());
  pi.on("ui_prompt_end", () => cancel());

  // Any new input or new run means the user came back.
  pi.on("input", () => cancel());
  pi.on("before_agent_start", () => cancel());
  pi.on("agent_start", () => cancel());

  pi.on("session_shutdown", () => cancel());
}
