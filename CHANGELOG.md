# Changelog

## [0.4.0] — 2026-10-24

### Added
- **Machine-initiated turns no longer arm pushes**: a turn whose run saw no user `input` (i.e. settlement auto-wakes — keel-flow/keel-crew inject their wake via `sendCustomMessage`, which never fires the `input` event) is the machine reporting to itself, and its `agent_settled` now skips scheduling ("machine self-talk is not a notification"). Previously every background-task settlement re-armed the 5-minute idle timer, so a night of automated turns meant a barrage of Bark pushes to an absent user.

### Changed
- Idle-rearm semantics unchanged otherwise: user-typed turns (including mid-run steers) still arm the timer; ask dialogs still schedule immediately (a real question is worth a push).

## [0.3.1] — 2026-10-24

### Fixed
- **Scripted (`pi -p`) runs hung forever**: the presence timers (first alert + repeats) were ref'd `setTimeout`s, so headless runs never reached an empty event loop — the alert chain even fired pushes minutes after the result was already on stdout. Timers are now `unref`'d, and scheduling is skipped entirely in headless runs (`-p`/`--print` or non-TUI `--mode`), where nobody sits at the terminal to be notified.
- Found via a pi-test-env probe matrix: budget-abort probes hung 100% of the time with bark active, 0% without; `process.getActiveResourcesInfo()` + a setTimeout-creation-stack tracker named `schedule()` as the only live ref'd timer at `agent_end`.
