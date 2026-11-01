#!/usr/bin/env node
/**
 * PTY host: runs ONE command on a real pseudo-terminal and bridges it to its parent.
 *
 * Bun.Terminal exists, but Bun 1.4.2 has no public output pause/resume API.
 * node-pty supplies that control so browser acknowledgements can stop PTY reads.
 * Keep it in Node: loading node-pty in Bun has panicked (oven-sh/bun#18546).
 * It comes as @lydell/node-pty, node-pty 1.1.0 repackaged with a prebuilt binary per
 * platform (Linux x64/arm64, macOS, Windows), so installing never runs node-gyp: a PC
 * without Python and a C++ toolchain installs the same as one with them.
 *
 * Protocol
 *   argv:   <cols> <rows> <command> [args...]
 *   stdin:  newline-delimited JSON control frames
 *             {"t":"i","d":"<text>"}          write text into the pty
 *             {"t":"r","c":<cols>,"r":<rows>} resize the pty
 *             {"t":"p","paused":true|false} pause/resume output (input stays live)
 *             {"t":"w"}                       signal SIGWINCH to the child at its current size
 *   stdout: raw pty bytes, unmodified
 *   stderr: diagnostics only
 *   exit:   mirrors the child's exit code
 */

// node-pty must never load inside Bun (AGENTS.md): a `node` that is Bun stops here, before the import
if (process.versions.bun) {
  process.stderr.write("pty-host: this is Bun, not Node; node-pty must not load here\n");
  process.exit(70);
}
const pty = await import("@lydell/node-pty");

const [colsRaw, rowsRaw, command, ...args] = process.argv.slice(2);
if (!command) {
  process.stderr.write("pty-host: usage: pty-host.mjs <cols> <rows> <command> [args...]\n");
  process.exit(2);
}

const cols = Number.parseInt(colsRaw ?? "", 10);
const rows = Number.parseInt(rowsRaw ?? "", 10);

// The bridge's bearer token never reaches the attach, however this host was launched.
const env = { ...process.env, TERM: "xterm-256color" };
delete env.OVIS_TOKEN;
delete env.HERDR_WEB_TOKEN;

const term = pty.spawn(command, args, {
  name: "xterm-256color",
  cols: Number.isFinite(cols) && cols > 0 ? cols : 80,
  rows: Number.isFinite(rows) && rows > 0 ? rows : 24,
  cwd: process.env.HOME ?? "/",
  env,
});

let parentPaused = false;
let stdoutBlocked = false;
function updateReading() {
  if (parentPaused || stdoutBlocked) term.pause();
  else term.resume();
  settleFinalRead();
}
term.onData((chunk) => {
  if (!process.stdout.write(chunk)) {
    stdoutBlocked = true;
    updateReading();
  } else settleFinalRead();
});

// node-pty destroys the pty's socket 200 ms after the command exits, and with it whatever is still unread
// there: output held for a paused parent or a full stdout, where reading stopped before the pty's end. That
// destroy waits until reading has caught up, as the Rust host does (crates/pty-sidecar): 200 ms quiet while
// reading, at most 2 s of reading, at most 15 s held. A destroy for a read error (EIO: the pty's end, all of
// it read) goes through at once. node-pty reports the exit only after the destroy, so what is left of the
// command's group is killed when it is asked for, as it was before the wait.
const EXIT_QUIET_MS = 200;
const EXIT_DRAIN_LIMIT_MS = 2000;
const EXIT_HELD_LIMIT_MS = 15_000;
/** node-pty's destroy once it asked for it: the command has exited */
let finalRead = null;
const socket = process.platform === "win32" ? undefined : term._socket;
if (socket) {
  const destroy = socket.destroy.bind(socket);
  socket.destroy = (...args) => {
    if (finalRead || args[0]) return destroy(...args);
    killGroup("SIGKILL");
    finalRead = { destroy: () => destroy(...args), heldUntil: Date.now() + EXIT_HELD_LIMIT_MS, since: null, timer: undefined };
    socket.once("close", () => clearTimeout(finalRead.timer));
    settleFinalRead();
    return socket;
  };
}
function settleFinalRead() {
  if (!finalRead) return;
  clearTimeout(finalRead.timer);
  const now = Date.now();
  let wait;
  if (parentPaused || stdoutBlocked) {
    finalRead.since = null;
    wait = finalRead.heldUntil - now;
  } else {
    finalRead.since ??= now;
    wait = Math.min(EXIT_QUIET_MS, finalRead.since + EXIT_DRAIN_LIMIT_MS - now);
  }
  finalRead.timer = setTimeout(finalRead.destroy, Math.max(0, wait));
}
process.stdout.on("drain", () => {
  stdoutBlocked = false;
  updateReading();
});

let exited = false;
// node-pty creates a session leader on POSIX. A launcher exiting is not proof its helpers ended.
// Windows' ConPTY close owns the console tree; negative process IDs do not exist there, and node-pty's
// Windows kill takes no signal (it throws on one, later, where this catch cannot see it).
function killGroup(signal) {
  try {
    if (process.platform === "win32") term.kill();
    else process.kill(-term.pid, signal);
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
}
term.onExit(({ exitCode }) => {
  if (process.platform !== "win32") killGroup("SIGKILL");
  exited = true;
  // Let the native exit callback unwind and stdout drain before Node exits.
  process.exitCode = exitCode ?? 0;
  process.stdin.destroy();
  process.stdout.end();
});

let pending = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  pending += chunk;
  let index = pending.indexOf("\n");
  while (index !== -1) {
    const line = pending.slice(0, index).trim();
    pending = pending.slice(index + 1);
    if (line) handle(line);
    index = pending.indexOf("\n");
  }
});

function handle(line) {
  if (exited) return;
  let frame;
  try {
    frame = JSON.parse(line);
  } catch {
    return;
  }
  try {
    if (frame.t === "i" && typeof frame.d === "string") term.write(frame.d);
    else if (frame.t === "r") term.resize(clamp(frame.c), clamp(frame.r));
    // a resize to the same size changes nothing the kernel signals: the child is told directly
    else if (frame.t === "w") { if (process.platform !== "win32") process.kill(term.pid, "SIGWINCH"); }
    else if (frame.t === "p" && typeof frame.paused === "boolean") {
      parentPaused = frame.paused;
      updateReading();
    }
  } catch (error) {
    process.stderr.write(`pty-host: ${error?.message ?? error}\n`);
  }
}

function clamp(value) {
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed) || parsed < 1) return 1;
  return Math.min(parsed, 1000);
}

let stopping = false;
const stop = () => {
  if (!exited && !stopping) {
    stopping = true;
    try {
      killGroup("SIGHUP");
      // A paused reader still needs to observe EOF after the parent leaves.
      term.resume();
    } catch {
      /* already gone */
    }
    // A child can ignore SIGHUP, and a blocked pipe must not pin the sidecar.
    setTimeout(() => {
      if (!exited) { try { killGroup("SIGKILL"); } catch { /* already gone */ } }
      process.exit(0);
    }, 2000).unref();
  }
};
process.on("SIGTERM", () => { stop(); process.stdin.destroy(); });
process.on("SIGINT", () => { stop(); process.stdin.destroy(); });
process.stdin.on("close", stop);
// The parent can disappear while output is in flight. Close the owned attach
// instead of turning the expected broken pipe into an uncaught Node exception.
process.stdout.on("error", (error) => {
  if (error.code !== "EPIPE") process.stderr.write(`pty-host: ${error.message}\n`);
  stop();
  process.stdin.destroy();
});
