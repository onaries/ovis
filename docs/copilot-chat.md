# Copilot chat

On Linux, Chat reads Copilot CLI's native `events.jsonl`: user and assistant text,
tool activity, recorded model/effort, recorded `ask_user` choices and Autopilot completion
summaries. Reading Chat makes no model calls. Live questions and approvals stay in Terminal;
the bridge never sends guessed selection keys. macOS and Windows use Terminal.
This reader supports existing panes; it does not add Copilot to the launch picker.

## Setup and session identity

Run `herdr integration install copilot` in the effective Copilot home before starting a
pane to enable Herdr's session report. Ovis never changes the CLI configuration.
The reader uses the foreground process's `--config-dir`, then `COPILOT_HOME`, otherwise
`HOME/.copilot`; an explicit `--log-dir` selects its log directory.

The foreground process's own open CLI log can identify its current session through
`Registering foreground session` and `Unregistering foreground session` records.
Copilot CLI 1.0.103 was observed emitting these records; this is not a guarantee for every
CLI version. A fresh registration can follow `/resume`, `/fork` and switch-back even
when older sessions remain open. File recency never selects a session.

Without a selected lifecycle registration, reading history requires both a trusted Herdr
report and exactly one canonical session marker held by that foreground process.
This fallback is allowed when no process log has been observed, or when the complete initial
log contains no lifecycle events. It does **not** recover from an unregister, ambiguous
lifecycle records, incomplete log lines, lost/rewritten log continuity, a deleted or unreadable
log, or a catch-up gap beyond the 16 MiB scan window without a fresh registration.
These cases use Terminal until current foreground evidence is available; repeated polling
does not turn invalid evidence into permission to read old history.

Existing panes with neither proof cannot be recovered by restarting the web server.
Resume the intended session in the CLI to establish fresh foreground evidence.

## History and limits

Before its first message, a genuinely new process can show an empty Chat when its
process-owned log or unique held marker identifies an unwritten session.
An explicit resume/continue without current foreground proof never gets a
fresh-session placeholder.

A recorded foreground switch invalidates pagination cursors and tool-output links,
including after switching back to the same session. Reload the current page for fresh
links. The marker-and-report fallback cannot detect an unobserved switch away and back.

The reader scans at most 16 MiB of lifecycle-log catch-up per lookup and checkpoints
complete reads, including unavailable selections. Ambiguity remains unavailable until a
fresh registration; it does not permanently block later registrations.
Unchanged file identity, size and timestamps reuse the last verification only when both
mtime and ctime were at least three seconds old at that check and the wall clock has not
moved behind it; younger timestamps or a clock rollback trigger rehashing
because a same-size rewrite may share their filesystem tick. Changed logs
revalidate the entire consumed prefix in 64 KiB chunks, including bytes outside the catch-up
window; logs over 64 MiB use Terminal without reading or hashing them.
This assumes filesystem timestamps trail this machine's clock by no more than that margin.
A filesystem with greater timestamp lag, such as a skewed network mount, can retain a stale
binding until the next append.
An incomplete trailing line keeps the last complete
binding only when its prefix rules out a lifecycle event. A partial timestamp or possible
foreground switch temporarily blocks Chat until the line is complete.
Observation state is bounded to 256 live process identities. Exited or replaced processes
release slots; at capacity, untracked processes use Terminal rather than forgetting a live
process's invalid evidence.
Transcript pages use the shared bounded pager. After reading, the pane's own process is
checked again using the request's existing peer claims. Unsupported or malformed complete
message records use Terminal instead of an empty Chat.
Tool-output searches read at most 32 MiB; an output beyond that limit is unavailable.

## Verification

```sh
HERDR_TEST_MODE=unit bun test server/copilot.test.ts
bun run check run bun test --timeout 20000 server/copilot.contract.test.ts
bun run check run --build bun scripts/copilot-chat-browser-qa.ts
bun run check fast
```

The HTTP contract and browser fixtures use fictional transcripts and disposable processes.
`server/fixtures/copilot-recorded.jsonl` is a redacted seven-record excerpt from a real CLI
session whose header identifies Copilot 1.0.102. Field names, nested collections, scalar types,
empty values and record/phase discriminators are preserved. Text, paths, identifiers, models,
timestamps and telemetry values are replaced; intervening records are omitted, so some parent
IDs point outside the excerpt. The unit test covers a root prompt with task ancestry, a
tool-only assistant message, its request/result and recorded assistant text. It does not
establish 1.0.103 lifecycle ordering, universal marker holding, a subagent discriminator or
compatibility with every CLI release. No raw private transcript or process log is published.
