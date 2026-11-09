# Moving herdr's session to herdr-core

Settings > About offers "Move everything to herdr-core" on a PC whose Ovis serves herdr's TUI, has
herdr-core, can switch its runtime (Linux and macOS, started by Ovis's launcher) and has no Herdr app
installed (the app arranges a core in a document Ovis never writes). It moves all of herdr's session
or nothing.

On such a PC without herdr-core (Linux and macOS, x64 and arm64), the row reads "Install herdr-core
and move everything" instead. Its button installs herdr-core 0.1.17 the way herdr-core's own installer
does, into `~/.local/bin/herdr-core` (with `hc` linked beside it when no `hc` exists), without
sudo: the version and the SHA-256 of each archive are pinned in `server/herdr-core/install.ts`
(the same hc the desktop app carries), the download must match it and the program must answer
`--version` as that hc before anything is written there. A `herdr-core` already in `~/.local/bin` is
never replaced, and a failed install leaves the folder as it was. herdr's TUI and its config are not
touched. Once it is in, the move's plan opens as usual; nothing moves until "Move everything".

## What moves

| herdr | herdr-core |
|---|---|
| Workspaces, tabs, their order and names | the same, as `herdr.space` / `herdr.tab` / `ovis.*` labels and the `ovis-layout` document ([herdr-core-layout.md](herdr-core-layout.md)) |
| Splits and their ratios | the same tree, rebuilt from herdr's `split_<n>_<path>` ids |
| An idle Claude Code whose input box reads empty, its conversation in this PC's stores | ended by Ovis, reopened on that conversation (the commands Earlier sessions uses) |
| An idle Claude Code whose conversation cannot be told | ended by Ovis, started new in the same folder |
| An agent the person ended (the pane still names its conversation) | reopened on that conversation; nothing is typed |
| A shell with nothing running in front | a new shell in the same folder |

Scrollback, programs running in a shell and anything kept only in a process's memory do not move.
One conversation reopens in one pane only.

## What makes it wait

An agent at work, waiting for an answer, or with a message Ovis still holds for it; a shell whose
foreground process is not the shell (or whose processes herdr cannot tell): the move waits and goes
by itself once none is left, until it is cancelled. Any other agent, one with text typed in its
input line, or one Ovis has no exit command for, waits for the person to end it: Ovis cannot read
those input lines, and its exit command, sent as a message, would send what is typed there. Once
the person ends it, its conversation reopens on herdr-core.

While it waits, the dialog lets the person end a shell's command where they would with Ctrl+C
(`POST /api/runtime/move/stop`, only while the move waits and only for a shell running a command):

- End sends Ctrl+C to that pane through its input lane, behind anything typed or sent before it
  (and after keys typed into its terminal have settled), once the same process group is still in
  front of the same shell and the command is still the one the row showed.
- Force end is offered only when Ctrl+C was sent at least 3 s earlier and that same group still
  runs; it sends SIGTERM to the pane's foreground process group (the group herdr names in
  `pane.process_info`), never to a process found by name. The group is the job the shell runs, so
  everything in it ends. A pane running this Ovis server, its process group or its launcher is
  refused. This relies on herdr and the server sharing one PC's process ids, as the move does.
- End all and move now asks the server for the running commands it would end
  (`POST /api/runtime/move/stop-all` with `{}`), shows "Ends N running commands. Unsaved work may be
  lost." for that list, and sends its token on confirm. The server ends nothing when the list (panes,
  commands, process groups) is no longer the one it offered; the person is asked again. A token is
  used once and belongs to one wait.
- Nothing is sent or signalled when Ovis cannot tell its own process group (Linux reads
  `/proc/self/stat`, macOS asks `ps`), and a cancel that arrives while herdr answers the last look
  sends nothing: herdr checks the wait again right before it writes Ctrl+C.
- Force end signals only when this PC itself reports that group in front of the shell's terminal
  (`/proc/<shell>/stat` tpgid, or `ps -o tpgid=` on macOS); otherwise (`not_local`, e.g. Ovis and
  herdr in different pid namespaces) nothing is signalled. It is still not atomic: a process group
  has no pidfd, so between that last look and the kill the group could end and its id be reused.
- The command a row or End all's confirm showed is compared with the name from the same look as the
  group that is ended, and End all ends each pane only while it runs the shell and group the confirm
  covered. The confirm lists the commands its token covers. A server that stops drops any stop still
  on its way.

Agents are never ended from the wait: their row opens the agent's pane, where the person ends it.
A pane that does not end keeps the move waiting, as before.

## How it runs

1. Each agent Ovis ends is sent its own exit command (`/exit`, through herdr's agent.prompt) only
   while herdr still says it is idle and its input box reads empty, and must be gone within 10 s. If it takes work instead, nothing
   more is typed into it and the move rolls back.
2. Everything is built on herdr-core through an adapter of the move's own, on a socket in the state
   folder, while the server still serves herdr. Every terminal it starts carries `ovis.move=<id>`.
3. The agents start there; then the runtime switches to herdr-core.

herdr is never closed or changed. On any failure before the switch is taken, every terminal labeled
with the move is ended, then each agent ended in herdr starts again in its own pane on its own
conversation, unless the pane has an agent again or the conversation runs elsewhere (the result
names those). Each step is written to `runtime-move-<port>.json` in the state folder before it is
taken; a server that stops mid-move leaves the move `interrupted`, and nothing is retried by itself.

To go back after a move, switch the runtime to herdr in Settings: herdr's workspaces, tabs and
shells are where they were, but the agents the move ended there stay ended (their conversations
run on herdr-core); end those on herdr-core first, then reopen them in herdr from Earlier sessions.

## One move at a time

Two Ovis servers can serve one herdr session: the PC's own and a connection server's bridge, say. Only one
moves it at a time. Before a move waits or starts, its server takes a lock the kernel alone arbitrates, in the
real folder of that session's socket (a symlinked folder, such as a dotfiles `~/.config`, is resolved, never
refused): `flock(2)` on `runtime-move.lock` there, which every server that sees that folder shares, in any
container. Every server takes this same lock; where no C library can be loaded for it, or the folder's filesystem
does not support locks, no move is started there (409 `move_lock_unsafe`, with why). A second server is refused (409 `already_moving`) while the holder
lives, and the kernel lets go when the holder's process ends, however it ends. Nothing is ever removed to take
it, so two servers that find a dead holder can never both go on. It then also listens on `runtime-move.sock`
there, the lock of Ovis before this one, so a server of that version still sees the session as taken, and is
seen: one listening there refuses the move. A server of that version can still race another in its own
recovery of a dead holder's socket file, as it always could; once every Ovis on that PC runs this version, no
two can. A socket file left there with nobody listening is removed, only
while this server holds the kernel lock, and only if it is a socket of this user's. No process id or start
time is read. The lock stays until the move ends: done, rolled back, cancelled, given up while waiting, or the
server stopping. A folder that is not this user's or that anybody may write in, or another kind of file at
`runtime-move.sock` or `runtime-move.lock`, is refused (409 `move_lock_unsafe`, in plain words). Moves run on Linux and macOS only.

## On another PC

A PC connected over SSH or through the relay is moved from the PC in front of you, with the same
plan, wait and stops. This server forwards that PC's own routes under the PC:
`GET|POST|DELETE /api/machines/:id/runtime/move`, `POST .../runtime/move/stop`,
`.../runtime/move/stop-all` and `.../runtime/move/install`, with the same requests and answers as
here. They go with that PC's credential (an SSH PC's bridge token, or this server's device on a relay
PC) and the header the move asks for; the browser's cookies and credentials never cross. They are the
owner's alone, from any device the owner signed in or paired to drive this PC; the plan too, which names
every pane's folder and conversation:

| Who | May move another PC, or every PC |
|---|---|
| The owner on this PC itself | Yes |
| The owner with the app's token | Yes |
| The owner's Tailscale login | Yes |
| A device the owner paired that drives | Yes |
| A device paired through the relay that drives (the owner's phone, another of the owner's PCs) | Yes |
| An open LAN visitor (nothing paired, no token) | No |
| A Portal visitor, even one given drive | No |
| A device that only watches, paired directly or through the relay | No |

Anyone else is answered 403. A change (anything but the plan's `GET`) also needs `x-herdr-update: 1`
from this app's own page.
A query is refused here, since that PC would refuse it.

On that PC, a Portal visitor is refused the move's routes whatever its role, and the bridge token counts
as an owner that drives it for the move's four routes and for the
runtime facts in `/api/health` (the full answer and `scope=bridge`): whoever holds it already drives
every pane there. Every other gate of the move still applies. Its install's request is held open for 180 s,
past the usual minute, since its download alone may take 120 s.

**Move all PCs**: `POST /api/machines/runtime/move-all` with `{ "plans": [{ "machine_id", "revision" }] }`,
the revision of each plan the person previewed through the forwarded `GET`. It starts each PC's move
at once, through the same route, and answers 202 `{ "started": [machine_id], "refused": [{ "machine_id",
"code", "message" }], "unknown": [{ "machine_id", "message" }] }`: a PC that is offline, unknown, this PC
or a herdr-core machine, or that refuses the start (`plan_changed`, `already_moving`, ...) is
refused, with why in plain words. A PC whose answer never came (the connection dropped or timed out)
(or a gateway answered 502 or 504 for it) is `unknown`: the start may have reached it, so look at its move status before trying again. Each
started PC then waits for its own busy panes; its stop and stop-all routes end them. Each PC is named
once, and never more plans than this server has PCs. It takes the
guards of every PC change (`X-Herdr-Machine: 1`, the same origin) and the owner's (the table above),
with `x-herdr-update: 1` and no query.

**The badge**: `GET /api/machines` and the `machines` event carry `runtime_move` on each connected
SSH or relay PC: `{ serving, offered, reason, status }`, read from that PC's own
`GET /api/runtime/move` when it connects, then every minute, every 5 s while its move waits or runs
(each read has that PC build its whole plan), and at once after a start, cancel or stop sent from here.
`serving: "herdr"` with `offered` is the "not moved yet" badge (`offered` with
`reason: "no_herdr_core"` installs herdr-core first). `status` is its move's progress, as every
roster (a watching device's too) may carry it: the state, a running move's step and count, and for a
move that could not finish only how many agents it left. Its reasons name folders and agents' words,
so they stay in the plan answer, which only a driving device reads. It is `null` when the PC cannot
tell (an Ovis without the route, one that does not take this server's credential there, or one with no
runtime to switch), and absent while it is not connected; a read that fails for a moment (herdr away, a
timeout) keeps the badge it had.

**An older Ovis**: a PC whose Ovis predates these routes (it answers 404 `not_found`, its answer to an
unknown route, or, over SSH, 401 or 403 to the bridge token; any other 404, a herdr error, is passed on
as it came) is answered 409 `pc_update_required`, "Update Ovis on that PC first, then move it."
