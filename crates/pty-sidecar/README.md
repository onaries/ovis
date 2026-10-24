# ovis-pty-sidecar

A PTY host written in Rust that speaks the protocol of `server/pty/pty-host.mjs`: the same argv
(`<cols> <rows> <command> [args...]`), the same newline-delimited JSON control frames on stdin
(`i` input, `r` resize, `p` pause/resume output reads, `w` SIGWINCH at the current size), the pty's
bytes on stdout, and the child's exit code. Linux and macOS only.

Its stdin is bounded: a control frame longer than 17 MiB is discarded up to its newline, and once
16 MiB of input wait for a command that is not reading (each frame counted with 80 bytes on top of its
own, empty ones not queued), further input frames are dropped (one stderr line per overflow) while
resize, pause and stop frames keep working. The command runs as the
leader of its own process group, which the host kills whenever it ends: the command exiting, a stop
(stdin closed, SIGTERM, SIGINT, SIGHUP, SIGQUIT, a broken stdout) or a crash (SIGABRT, SIGSEGV,
SIGBUS, SIGILL, SIGFPE). A host killed outright (SIGKILL) cannot do that: on Linux the command itself
is killed with it (`PR_SET_PDEATHSIG`), and the rest of the group gets the pty's hangup. After the
command exits, its output is read until EOF, 200 ms of quiet or 2 s; output paused then is held for
up to 15 s.

## Where it comes from

On Linux and macOS this host is the default. Each release ships it (`.github/workflows/pty-sidecar.yml`),
and the plugin's build, each update installed from the app and `install.sh` put the binary for the
PC in `bin/ovis-pty-sidecar` beside the server, checked against the release's SHA-256
(`scripts/pty-sidecar.ts`). Without that binary, the server takes a local build:

```bash
cargo build --release --manifest-path crates/pty-sidecar/Cargo.toml
bun run server
```

`OVIS_PTY_SIDECAR_BIN` points at a binary elsewhere (a leading `~/` is expanded, as the plugin's
`env` file is not a shell). Name the binary itself, or a wrapper that `exec`s it, so that the
server sees how the host ended. `OVIS_PTY_SIDECAR=node` asks for the Node sidecar instead, and
`OVIS_PTY_SIDECAR=rust` makes a host that cannot run a warning on stderr rather than a log line.

## When it cannot run

The server falls back to the Node sidecar, where the PC has a Node 18 or newer, says why once, and keeps attaching:

- **Before the first use** (at startup), it runs the binary twice: with no
  arguments it must print its usage line and exit 2, and `1 1 true` must exit 0. A missing file,
  one that is not executable or not for this CPU, another program, a host that crashes or hangs
  (3 s), or a PC where it cannot open a pty fails the check, and every attach uses Node.
- **When it cannot be started** after passing (the file was removed or replaced), that attach
  starts on Node.
- **When it ends by a signal the server did not send** (a crash, the out-of-memory killer), that
  attach ends as an attach does when its host stops, and every later one uses Node until the
  server restarts.

Other values of `OVIS_PTY_SIDECAR` than `rust` and `node` are reported once and mean Node.

A PC without Node attaches its panes on this host alone. Only with neither (a host that fails its
check and no Node) are panes mirrored. Remote PC bundles carry this host beside their own Node.
Windows has no Rust host and mirrors.

## Checks

```bash
cargo test --manifest-path crates/pty-sidecar/Cargo.toml   # frame parsing
bun test server/pty/host.test.ts                           # the same PtySession checks on both hosts
OVIS_PTY_SIDECAR=rust bun test server/pty/session.test.ts  # the session's own tests, on this host
bun scripts/pty-sidecar-bench.ts                           # startup, teardown, echo, throughput, memory, a real attach
```

The Rust checks in `server/pty/host.test.ts` are skipped when the binary has not been built. CI's
Rust PTY host job builds it on GitHub's Ubuntu image and runs `cargo test`, `host.test.ts` and
`session.test.ts` on it; the other jobs run without it.
