# Letta Code screens

Recorded 2026-10-29 in an isolated herdr session (herdr 0.9.5) with Letta Code 0.34.23 (local backend,
gemini-3.1-flash-lite through a local OpenAI-compatible proxy) for the chat's live terminal box
(`src/lib/lettaScreen.ts`), read by `src/lib/lettaScreen.test.ts`. Each file is the last 30 lines of
`herdr pane read --source recent_unwrapped --format text --lines 60`, as the box reads the pane.

- `working-tool-0.34.23.txt`: a turn at work, its Bash call running, under the spinner row and its tip.
- `working-typed-0.34.23.txt`: the same turn later, with a follow-up typed into Letta's input.
- `done-0.34.23.txt`: right after the turn ended (no spinner row).

Redacted: the shell prompt's user and host read `user@host`, and the user and group in `ls -la`
read `user000`, the same width as before, so the layout is unchanged.
