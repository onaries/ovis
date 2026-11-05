### Added
- Kimi Code panes get a chat: the conversation is read from the CLI's own wire log
  (`~/.kimi-code/sessions/wd_<dir>_<hash>/session_<id>/agents/main/wire.jsonl`), with user prompts,
  answers, thinking and tool calls as turns, instead of falling back to the terminal scrollback.
  Injections, task notifications and cron firings the CLI stores as messages are not shown as
  prompts. The pane's session is proven by the session lock the CLI writes for the pane's own
  process (`~/.kimi-code/locks/sessions/`), or on Linux by the main log that process holds open,
  and an idle Kimi keeps its last session while the same process runs, until `/sessions` or
  `/resume` is typed there; without that proof the pane keeps its terminal, never another session
  of the folder. Prompts `/undo` took back are left out of every page.
  herdr-core's `kimi-code` label maps to `kimi`.
