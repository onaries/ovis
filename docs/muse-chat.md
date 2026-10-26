# Muse Code Chat

Chat reads the Muse Code session log of the session on screen: user messages, assistant
answers, reasoning summaries and expandable tool activity, in the existing Chat view. Terminal
remains the place for approvals, questions and Muse's own commands. Reading Chat makes no model
call and needs no Muse configuration.

## Finding the session

herdr labels a pane that runs `muse`, or the versioned `muse-bin-…` binary its launcher starts,
as `muse`, but reports no session for it. Muse writes `.session.lock` into each session
directory it opens, with `pid=<pid>` and, on recent builds, `host=<host>`, and never removes it.
Muse 1.4.13 empties it when it leaves the session.

The reader takes the pane's Muse foreground processes, then the top-level locks under
`${XDG_DATA_HOME:-~/.local/share}/muse/sessions/YYYY/MM/DD/<id>/` that name one of their pids
(and this PC's host name, when a lock names one) and were written since that process started.
A lock left by an earlier process with the same pid is older than the process, so it never
counts. A `muse` launcher that stays alive beside its `muse-bin-…` child holds no lock, so it
binds nothing.

A session the TUI switched away from ends its log with `session.end` and is dropped, as is a
lock whose log does not exist yet. A scan must leave exactly one session; otherwise Chat uses
Terminal. Folder, recency and argv never choose a session, so panes in one folder each show
their own, and an in-TUI `/resume` is followed at once: Muse writes the resumed session's lock
and its `session.resumed` record as it switches. `/fork` does not switch: the source session
stays open in its pane, and Muse opens the fork in a new tab, where another process holds the
fork's lock.

Every lookup reads the locks again, so its result never depends on an earlier one: two live
sessions for the pane's processes leave none, and Chat uses Terminal. Each switch Muse makes
(`/new`, `/resume`) ends the log it leaves, so a switch does not leave two. A scan that binds
nothing is not repeated for two seconds, the interval at which the monitor resolves such a
pane, so a session Muse opens after a failed scan can take that long to show. Only the first
1 KiB of a lock is read. A store of more than 4096 sessions, or a folder in it with more than
4096 entries, is not read, and Chat uses Terminal.

The data directory comes from the server's `XDG_DATA_HOME`; a Muse started with another one
uses Terminal. A process's start time comes from the kernel's process record on macOS (with a
three-second margin) and `/proc` on Linux (to 10 ms, so a 20 ms margin). Windows uses Terminal.

## What is read

- **Prompts:** `runtime.user_intent.accepted`, once per message sent, including one sent while
  Muse works. `run/started` repeats the words and is not read.
- **Answers:** `assistant_message_committed`. Muse marks progress prose `commentary`, which folds
  into the turn's work block; the rest is the answer. When a run ends with
  `terminal: "completed"` on an answer, that answer is final, and Chat marks the turn as done.
- **Reasoning:** `reasoning_summary_committed`. `reasoning_committed` is encrypted and skipped.
- **Tools:** calls from `assistant_tool_calls_committed`, results from
  `tool_result_batch_committed` by call id. A JSON envelope shows its `output`, and a non-zero
  `exit_code` marks the call failed, as do Muse's own `tool denied: …` and `tool failed: …`;
  any other result is shown as written.
  **Show all** reads the whole result from the log.
- **Compaction:** the `summary_text` of `context_compaction_installed`.
- **Model:** `run.model.configured` and each `model_completed`. Muse records no reasoning effort
  and no context window, so neither is shown.

These record shapes are the same from Muse 1.4.2 to 1.4.13. Every other record is bookkeeping,
as are the `retained_marker` and `retained_frame` lines. Every line is parsed: on a test Mac, a
16 MiB page of a real log parses in about 16 ms.

Chat uses Terminal when the log is missing or cannot be read, or when a whole line:

- does not parse;
- names a record, a `runtime.session` kind or a run event that is not in the logs of Muse 1.4.2
  to 1.4.13 (61 records and 56 run events, from 160 session logs on one test PC);
- names another session in its `stream`, as Muse names each log's folder after its session;
- is a record above in another shape: a prompt block other than `text` or a picture (`asset`),
  a tool call without `name`, a result without `text`, or a compaction other than `summary_text`.

The last line can be one Muse is still writing, so it is skipped until it is whole. The 160
session logs all read without a refusal.

A log rewritten in place, rather than appended to, starts a new history, so that its cursors and
the turns kept from earlier reads no longer count: when it gets smaller, when it keeps its size
with a new time, or when it grows while the last 16 MiB it held before changed.

## Limits

- Prompt cards, slash commands, todos and plans, subagents, pictures and Earlier sessions are
  outside this first scope. A picture shows as the `[Image #n]` name Muse gives it.
- A forked session's Chat starts at the fork. Muse copies the turns before it into the fork's
  log as `session.fork.turn` records, which are not shown.
- Only the pages Chat reads are checked. A line further back that Chat cannot read sends that
  older page to Terminal, and Chat then shows no turns older than the pages it has. Grok and
  Antigravity behave the same.
- A rewrite further back than the last 16 MiB of a log that also grew is not seen.
- A result shows what the model received. Muse keeps longer originals in the session's
  `tool-outputs/`, which is not read.
- A result recorded after a later prompt, while its call is on an earlier page, shows on a row of
  its own.
- What `/rewind` records is not handled yet: Chat can keep the turns it went back over.

## Verification

```sh
HERDR_TEST_MODE=unit bun test ./server/muse.test.ts
bun run check run bun test --timeout 20000 ./server/api.contract.test.ts --test-name-pattern 'Muse conversation API'
bun run check fast
```

`server/fixtures/muse/recorded-1.4.13.jsonl` is a session recorded from Muse 1.4.13, with its
records as Muse wrote them: tool calls, a failed command, a declined call and a `/model` switch.
Its README says what was replaced. `session.jsonl` beside it is fictional, written in the record
shapes of real 1.4.12 logs, for the cases the recording does not have (a compaction, a long
output). The contract test runs a stand-in process named `muse` in an isolated herdr, checks that
a lock naming another pid binds nothing, then reads the recorded session over HTTP, a whole tool
output, a switch to a second session, and Terminal for a renamed record and for a log it cannot
read. It does not run the Muse TUI.
