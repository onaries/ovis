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

## Recorded branches

`recorded-1.4.13-main.jsonl`, `-fork`, `-side` and `-rewind` are four `session.jsonl` logs that
Muse Code 1.4.13 wrote on macOS on 2026-10-26, with `muse-spark-1.3` at `max` effort, in an
isolated herdr session, a temporary data directory and a throwaway folder. The user's Muse
settings ran them without approval prompts. The main session holds three prompts:

1. A picture attached with `--image`: what color is it. Muse writes `[Image #1]` in the words and
   the picture as an `asset` block.
2. `@shed.txt` picked from the file completion: how many items the file lists. Muse sends the
   mention as the words `shed.txt`.
3. Start one subagent that counts the lines of `notes.txt`, wait for it, and give its number.

Then `/fork` opened the fork in a new tab, where one more prompt ran (`-fork`). `/side` asked one
question in a side chat (`-side`). `/rewind` went back to the second prompt, which was sent again
with more words (`-rewind`). `/exit` ended both processes.

The replacements of the first recording apply here too, and also these:

- the data directory with `/home/user/.local/share`, the macOS temporary folder with `/tmp`, and
  the user name in `ls -l` output with `user`;
- the `text` of each `developer` message that a fork copies into `session.fork.model_prefix`
  (Muse's own instructions and the user's context), with `[removed: <n> characters]`.

257 of the 1178 lines changed. The subagent logs under `subagent/` are not kept.

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
