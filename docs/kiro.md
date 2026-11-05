# Kiro CLI conversations

On Linux, the chat lens reads Kiro CLI's own session log (checked with Kiro CLI 2.35.1 and 2.35.2 on its
default V2 engine). A pane is read as Kiro when herdr labels it `kiro`, or, while herdr has not labeled it
yet, when Kiro's chat TUI is in front: `kiro-cli chat`, `kiro-cli-chat chat`, or the `bun … /kiro-cli/tui.js
chat` they start.

## Which session

herdr 0.9.5 reports no session for Kiro panes, and no Kiro process keeps its session file open. Kiro does
write `<id>.lock` = `{"pid", "started_at"}` beside the session its `kiro-cli-chat acp` process has open. That
process is a child of the TUI in its own session, so herdr does not list it. Kiro writes the lock when a
session opens (with an empty `<id>.jsonl`), moves it on `/chat new`, `/chat <id>` and `/rewind`, and deletes
it on `/quit`.

The pane reads the one session whose lock names the `kiro-cli-chat acp` child of its own foreground TUI and
was written after that process surely started. Folder and recency never pick a session. Each process is pinned
by its start time, and the processes and the lock are read again after the log is opened: a session switch or a
replaced process in between keeps the terminal for that read. So:

- Two Kiro panes in one folder each read their own session.
- A Kiro that has not opened its session yet, or was quit, stays on Terminal.
- A fresh session shows an empty chat: it is the pane's own session, before its first prompt.
- After `/chat <id>`, the chat follows once Kiro moves the lock. Until then it shows the session Kiro still
  has open.
- Two locks for one process, a lock not newer than its process (an earlier process with that pid), a lock that
  is a link or not a regular file, and a log that links out of the store or to another session keep the terminal.

The store is `$KIRO_HOME/sessions/cli`, else `~/.kiro/sessions/cli`, read from the acp process's own
environment. The log's real path must be directly inside that folder, owned by the same user; the reader
pins the file identity for conversation and tool-output reads.

## What it shows

Prompts, answers (dated by their prompt: Kiro dates only prompts), tool calls with Kiro's own purpose line,
their results (a command's stdout and stderr), cancelled and failed tools (a command that exited non-zero, which
Kiro records as a success with its `exit_status`), a `/clear` marker with the earlier chat kept above it, as Kiro's own view keeps
it, and `/compact` summaries. Reasoning that Kiro stores encrypted is not shown. The newest page holds up to
50 turns, or the number of prompts the reader asks for; longer tool output is cut in the page and can be expanded. Logs over 16 MiB, other record versions,
prompts with anything but text (an image), and records this reader does not know (`ResetTo` and `CancelledPrompt`, which Kiro 2.35 defines but was not
seen writing) keep the terminal. An unfinished last line is ignored until Kiro finishes writing it.

Kiro's V3 engine (`kiro-cli --v3`) keeps its sessions elsewhere and stays on Terminal, and so do macOS and
Windows, where the binding has no procfs. Prompt cards and tool approvals are answered in the terminal.
