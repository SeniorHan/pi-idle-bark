# pi-idle-bark

Presence-aware [Bark](https://github.com/Finb/Bark) notifications for the [Pi coding agent](https://www.npmjs.com/package/@earendil-works/pi-coding-agent).

Most Bark extensions push on **every** agent turn — so while you are sitting at the terminal, your phone buzzes for every single reply. `pi-idle-bark` is built on the opposite premise:

> **Only reach the phone when the session has actually been waiting for you.**

- ⏳ Fires only after the agent has settled (or a blocking prompt opened) with **no input for `thresholdMinutes`** (default 5). Normal back-and-forth at the desk = complete silence.
- 🔁 Still away? Re-pings every `repeatMinutes` (default 30), up to `maxRepeats` (default 3).
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
  "repeatMinutes": 30,
  "maxRepeats": 3,
  "params": { "group": "pi", "sound": "bellina", "level": "timeSensitive" }
}
```

- `endpoint` — Bark server base URL. Self-hosted? Use e.g. `https://bark.example.com`.
- `deviceKey` — the key shown in the Bark iOS app. **Required**; without it the extension stays dormant.
- `params` — arbitrary extra Bark payload fields (`group`/`sound`/`level`/`icon`/…), merged into every push.

Environment overrides (win over the file): `PI_IDLE_BARK_ENABLED`, `PI_IDLE_BARK_ENDPOINT`, `PI_IDLE_BARK_KEY`, `PI_IDLE_BARK_MINUTES`, `PI_IDLE_BARK_REPEAT_MINUTES`, `PI_IDLE_BARK_MAX_REPEATS`.

## How it works

| Pi event | Effect |
|---|---|
| `agent_settled` (not aborted) | arm the idle timer |
| `ui_prompt_start` (blocking prompts, incl. ask-user dialogs) | arm the idle timer |
| `message_end` (assistant) | remember last reply text for the snippet |
| `input` / `agent_start` / `ui_prompt_end` | cancel any pending alert |
| `agent_settled` (aborted) | ignored — the user is at the keyboard |

Push body: `No input for 12m: <last assistant reply snippet>`.

## Why not push immediately?

Two great packages already do that — [@henryqw/pi-bark](https://npm.im/@henryqw/pi-bark) and [@herbertgao/pi-bark](https://npm.im/@herbertgao/pi-bark). Use those if you want a push per turn. `pi-idle-bark` exists for the walk-away-from-the-desk workflow: long-running agent tasks (multi-hour refactors, eval sweeps, big test suites) where an immediate push is pointless — you aren't near the phone either — and per-turn pushes are pure spam.

## License

MIT
