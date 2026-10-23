# Changelog

## [0.3.1] — 2026-10-24

### Fixed
- **Scripted (`pi -p`) runs hung forever**: the presence timers (first alert + repeats) were ref'd `setTimeout`s, so headless runs never reached an empty event loop — the alert chain even fired pushes minutes after the result was already on stdout. Timers are now `unref`'d, and scheduling is skipped entirely in headless runs (`-p`/`--print` or non-TUI `--mode`), where nobody sits at the terminal to be notified.
- Found via a pi-test-env probe matrix: budget-abort probes hung 100% of the time with bark active, 0% without; `process.getActiveResourcesInfo()` + a setTimeout-creation-stack tracker named `schedule()` as the only live ref'd timer at `agent_end`.
