# Muse Code sessions

## Recorded session

`recorded-1.4.13.jsonl` is the `session.jsonl` that Muse Code 1.4.13 wrote on macOS on
2026-10-25, with the default `muse-spark-1.3` model, in an isolated herdr session, a temporary
data directory and a throwaway folder. It was run with `--approval-mode untrusted` so that each
command asked for approval. It holds three prompts:

1. Read `notes.txt`, run `sh greet.sh` and `ls missing-folder` (a command that fails), then
   answer in one sentence.
2. Run `rm greet.sh`, a call declined at the approval prompt (`tool denied: approval aborted`).
3. After `/model` switched to `muse-spark-1.2`, count the lines of `notes.txt`. Then `/exit`
   ended the session.

Every record, key and key order is as Muse wrote it, the `retained_marker` and `retained_frame`
lines included. Only these string values were replaced:

- the throwaway folder path with `/home/user/garden`, the home directory with `/home/user`, and
  the runtime socket folder with `/tmp/tbh-1000-rt`;
- Muse's own text and the user's context, each with `[removed: <n> characters]`:
  `base_instructions`, the `text` of each `run_context_messages` entry, each reminder agent's
  `duty`, `advisory_text` and the encrypted `encrypted_content`.

The prompts, answers, reasoning summaries and tool results are the session's own, about the
fictional files. 133 of the 504 lines changed. The subagent logs Muse wrote beside it are not
kept.

## Fictional session

`session.jsonl` is written by hand in the record shapes of Muse Code 1.4.12, compared field by
field with real session logs on 2026-10-22. Every text, path, command and id is fictional; no
user history was copied. Long payloads Muse also writes (base instructions, hook bookkeeping,
task lifecycle rows) are left out or cut to one record, since the reader skips them.

It holds two prompts. The first runs five tool calls: a passing and a failing `bash` (JSON
envelope with `exit_code`), a `read_file` with plain text, a call the user declined (`tool
denied: …`) and one whose output is longer than a page carries. Reasoning, a commentary-phase
answer and a final answer surround them. Between the prompts, `/model` switches the model. The
second prompt holds a compaction summary. `run/started` repeats each prompt and must not.
