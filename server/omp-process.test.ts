import { expect, it, spyOn } from "bun:test";
import { processEnviron } from "./omo.ts";
import { createOmpProcessProbe, ompRoutingEnviron, processStartTicks } from "./omp-process.ts";

// The probe answers null, by design, for a process in uninterruptible sleep or one whose memory
// cannot be read in time. A bun target spends its first milliseconds, longer on a loaded PC, paging
// in its binary (state D), and the helper itself is a bun that can take over the default 1 s to
// start there. So the targets are a small shell that says when it is up and then waits in a read,
// and the reads that are not about the deadline get one no busy PC reaches.
const READ_MS = 30_000;
async function startedShell(args: string[], env?: Record<string, string>) {
  const argv = ["/bin/sh", "-c", "echo READY; read _", "sh", ...args];
  const target = Bun.spawn(argv, { env, stdin: "pipe", stdout: "pipe", stderr: "ignore" });
  const reader = target.stdout.getReader();
  const decoder = new TextDecoder();
  let said = "";
  while (!said.includes("READY\n")) {
    const chunk = await reader.read();
    if (chunk.done) throw new Error(`the target shell exited before it was up: ${said}`);
    said += decoder.decode(chunk.value, { stream: true });
  }
  reader.releaseLock();
  return { argv, target };
}

it.skipIf(process.platform !== "linux")("reads a live process's arguments and only the environment omp lookups need", async () => {
  const env = { PATH: process.env["PATH"] ?? "", OMP_PROFILE: "personal", TMUX: "/tmp/tmux-1/default,1,0", TMUX_PANE: "%3", SECRET_TOKEN: "do-not-pass" };
  const { target } = await startedShell([], env);
  try {
    const read = createOmpProcessProbe({ timeoutMs: READ_MS });
    const result = await read(target.pid, true);
    expect(result?.argv.length).toBeGreaterThan(0);
    expect([...result?.environ ?? []].sort()).toEqual(["OMP_PROFILE=personal", "TMUX=/tmp/tmux-1/default,1,0", "TMUX_PANE=%3"]);
    expect((await createOmpProcessProbe({ timeoutMs: READ_MS })(target.pid, false))?.argv).toEqual([]);
    expect(await read(2147483647, true)).toBeNull();
  } finally { target.kill(); await target.exited; }
});

it.skipIf(process.platform !== "linux")("keeps only the variables omp's store lookup reads, through the helper and the direct read", async () => {
  const routing = {
    HOME: "/r", OMP_PROFILE: "work", PI_PROFILE: "pi", PI_CONFIG_DIR: ".alt", PI_CODING_AGENT_DIR: "/r/agent", PI_CODING_AGENT_SESSION_DIR: "/r/sessions",
    XDG_DATA_HOME: "/r/data", XDG_STATE_HOME: "/r/state", TMUX: "/tmp/tmux-1/default,1,0", TMUX_PANE: "%3",
  };
  // secrets, look-alike names and the XDG roots omp's store lookup never reads
  const env = { ...routing, PATH: process.env["PATH"] ?? "", SECRET_TOKEN: "SECRET_TOKEN_value", OPENAI_API_KEY: "SECRET_TOKEN_key", PI_CODING_AGENT_DIR_EXTRA: "SECRET_TOKEN_x", HOMEDIR: "SECRET_TOKEN_h", XDG_CONFIG_HOME: "/r/config" };
  const { target } = await startedShell([], env);
  try {
    const expected = Object.entries(routing).map(([key, value]) => `${key}=${value}`).sort();
    const helper = await createOmpProcessProbe({ timeoutMs: READ_MS })(target.pid, true);
    expect([...helper?.environ ?? []].sort()).toEqual(expected);
    const direct = ompRoutingEnviron(processEnviron(target.pid));
    expect([...direct ?? []].sort()).toEqual(expected);
    expect(JSON.stringify([helper, direct])).not.toContain("SECRET_TOKEN");
  } finally { target.kill(); await target.exited; }
  // an environment read empty is a process gone or not ours, not one without the variables
  expect(ompRoutingEnviron(null)).toBeNull();
  expect(ompRoutingEnviron([""])).toBeNull();
  expect(ompRoutingEnviron(["PATH=/bin", ""])).toEqual([]);
});

it.skipIf(process.platform !== "linux")("keeps a process's empty arguments where they stand", async () => {
  const { argv, target } = await startedShell(["--cwd", "", "/B", ""]);
  try {
    expect((await createOmpProcessProbe({ timeoutMs: READ_MS })(target.pid, true))?.argv).toEqual(argv);
  } finally { target.kill(); await target.exited; }
});

it.skipIf(process.platform !== "linux")("keeps a successful read per process start, never a failed one", async () => {
  const start = processStartTicks(process.pid)!;
  let starts = 0, fail = true, ticks = start;
  const read = createOmpProcessProbe({
    timeoutMs: READ_MS,
    startTicks: () => ticks,
    command: () => { starts++; return [process.execPath, "-e", fail ? "process.exit(1)" : `console.log(JSON.stringify({start:${JSON.stringify(start)},argv:["omp"],environ:[]}))`]; },
  });
  expect(await read(process.pid, true)).toBeNull();
  fail = false;
  expect((await read(process.pid, true))?.argv).toEqual(["omp"]);
  expect((await read(process.pid, true))?.argv).toEqual(["omp"]);
  expect((await read(process.pid, false))?.argv).toEqual(["omp"]);
  expect(starts).toBe(2);
  // the pid now names a process that started at another time: the helper's answer is not its
  ticks = `${start}1`;
  expect(await read(process.pid, true)).toBeNull();
  expect(starts).toBe(3);
});

it.skipIf(process.platform !== "linux")("a stalled memory read has a deadline and leaves the event loop responsive", async () => {
  const read = createOmpProcessProbe({ timeoutMs: 100, command: () => [process.execPath, "-e", "setInterval(() => {}, 1000)"] });
  const result = read(process.pid, true);
  let settled = false;
  void result.then(() => { settled = true; });
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(settled).toBe(false);
  expect(await Promise.race([result, new Promise((resolve) => setTimeout(() => resolve("deadline missed"), 1000))])).toBeNull();
});

it.skipIf(process.platform !== "linux")("deduplicates reads and bounds outstanding helpers when polling repeats", async () => {
  let starts = 0;
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  try {
    const read = createOmpProcessProbe({ timeoutMs: 100, maxProcesses: 1, startTicks: () => "1", command: () => { starts++; return [process.execPath, "-e", "setInterval(() => {}, 1000)"]; } });
    const first = read(1, true);
    expect(read(1, true)).toBe(first);
    expect(await read(2, true)).toBeNull();
    expect(await read(3, true)).toBeNull();
    expect(starts).toBe(1);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(await first).toBeNull();
  } finally { warn.mockRestore(); }
});

it.skipIf(process.platform !== "linux")("rejects malformed or excessive helper output and invalid process IDs", async () => {
  for (const script of ["console.log('not JSON')", "console.log(JSON.stringify({argv:[42],environ:[]}))", "console.log(JSON.stringify({start:'0',argv:[],environ:[]}))", "console.log('x'.repeat(1024*1024+1))", "process.exit(1)"]) {
    const read = createOmpProcessProbe({ command: () => [process.execPath, "-e", script] });
    expect(await read(process.pid, true)).toBeNull();
  }
  let starts = 0;
  const read = createOmpProcessProbe({ command: () => { starts++; return []; } });
  for (const pid of [-1, 0, 1.5, Number.NaN]) expect(await read(pid, true)).toBeNull();
  expect(starts).toBe(0);
});
