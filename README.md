# pi-idle-bark

Presence-aware [Bark](https://github.com/Finb/Bark) notifications for the [Pi coding agent](https://www.npmjs.com/package/@earendil-works/pi-coding-agent).

Most Bark extensions push on **every** agent turn — so while you are sitting at the terminal, your phone buzzes for every single reply. `pi-idle-bark` is built on the opposite premise:

> **Only reach the phone when the session has actually been waiting for you.**

- ⏳ Fires only after the agent has settled (or a blocking prompt opened) with **no input for `thresholdMinutes`** (default 5). Normal back-and-forth at the desk = complete silence.
- 🔁 Still away? Re-pings with **exponential backoff** (default 5m → ×2 → capped at 1h, unlimited repeats), fully configurable.
- ✨ Optional **smart mode**: an in-process Pi sub-session (your default model, or a configured `provider/modelId`) reads the last few assistant messages and writes a short, humanized push — in your conversation's language. One model call per waiting period; repeats reuse the cached text. Any failure falls back to the plain template.
- ✋ Any new input — typing, Escape, starting a run — cancels the pending alert instantly.
- 🚫 Aborted runs never notify (you just pressed a key, you're obviously there).
- 🧩 Works with the official `api.day.app` Bark server **or any self-hosted bark-server**.
- ⚡ Zero dependencies, zero build step (plain TypeScript loaded by Pi's jiti).

## Install

```bash
pi install npm:pi-idle-bark
```

## Configure

Create `~/.pi/agent/idle-bark.json`:

```json
{
  "enabled": true,
  "endpoint": "https://api.day.app",
  "deviceKey": "YOUR_BARK_DEVICE_KEY",
  "thresholdMinutes": 5,
  "backoff": { "baseMinutes": 5, "factor": 2, "capMinutes": 60, "maxRepeats": 0 },
  "smart": { "enabled": false },
  "params": { "group": "pi", "sound": "bellina", "level": "timeSensitive" }
}
```

- `endpoint` — Bark server base URL. Self-hosted? Use e.g. `https://bark.example.com`.
- `deviceKey` — the key shown in the Bark iOS app. **Required**; without it the extension stays dormant.
- `params` — arbitrary extra Bark payload fields (`group`/`sound`/`level`/`icon`/…), merged into every push.

### Repeat strategy

- `backoff` — exponential repeat gaps: first gap `baseMinutes` (default 5), then × `factor` (default 2) each time, capped at `capMinutes` (default 60); `maxRepeats` 0 = unlimited (default).
- Legacy fixed-repeat keys `repeatMinutes` / `maxRepeats` still work (30m × 3) when no `backoff` object is present.

### Smart notifications

```json
"smart": {
  "enabled": true,
  "model": "provider/modelId",      // omit → Pi default model
  "titleMode": "model",             // "model": LLM writes the title; "fixed": title stays ⏳ Pi is waiting
  "contextMessages": 2,             // recent assistant messages fed to the model
  "contextChars": 800,              // per-message truncation
  "includeMeta": true,              // cwd / wait time / pending-question hints
  "language": "auto",              // or an ISO code like "zh" / "en"
  "thinkingLevel": "low",
  "timeoutMs": 15000
}
```

The sub-session runs toolless and in-memory in the same process; one call per waiting period, cached for repeats, template fallback on timeout or parse failure. Note the last few replies are sent to the model provider you configure — keep that in mind for sensitive repos.

Environment overrides (win over the file): `PI_IDLE_BARK_ENABLED`, `PI_IDLE_BARK_ENDPOINT`, `PI_IDLE_BARK_KEY`, `PI_IDLE_BARK_MINUTES`, `PI_IDLE_BARK_SMART`, `PI_IDLE_BARK_SMART_MODEL`, `PI_IDLE_BARK_BACKOFF_BASE_MINUTES`, `PI_IDLE_BARK_BACKOFF_FACTOR`, `PI_IDLE_BARK_BACKOFF_CAP_MINUTES`, `PI_IDLE_BARK_BACKOFF_MAX_REPEATS` (setting any of these switches to exponential mode), plus legacy `PI_IDLE_BARK_REPEAT_MINUTES` / `PI_IDLE_BARK_MAX_REPEATS`. `PI_IDLE_BARK_DEBUG=1` logs smart-craft and repeat diagnostics to `~/idle-bark-debug.log`.

Environment overrides (win over the file): `PI_IDLE_BARK_ENABLED`, `PI_IDLE_BARK_ENDPOINT`, `PI_IDLE_BARK_KEY`, `PI_IDLE_BARK_MINUTES`, `PI_IDLE_BARK_REPEAT_MINUTES`, `PI_IDLE_BARK_MAX_REPEATS`.

## How it works

| Pi event | Effect |
|---|---|
| `agent_settled` (not aborted) | arm the idle timer |
| `ui_prompt_start` (blocking prompts, incl. ask-user dialogs) | arm the idle timer |
| `message_end` (assistant) | remember last reply text for the snippet |
| `input` / `agent_start` / `ui_prompt_end` | cancel any pending alert |
| `agent_settled` (aborted) | ignored — the user is at the keyboard |

Push body (template mode): `No input for 12m: <last assistant reply snippet>`. In smart mode the sub-session writes title + body instead.

## Why not push immediately?

Two great packages already do that — [@henryqw/pi-bark](https://npm.im/@henryqw/pi-bark) and [@herbertgao/pi-bark](https://npm.im/@herbertgao/pi-bark). Use those if you want a push per turn. `pi-idle-bark` exists for the walk-away-from-the-desk workflow: long-running agent tasks (multi-hour refactors, eval sweeps, big test suites) where an immediate push is pointless — you aren't near the phone either — and per-turn pushes are pure spam.

## License

MIT
