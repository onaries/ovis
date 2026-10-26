#!/usr/bin/env node
// A test-owned attach process. Gates hold attempts until the contract test releases them.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
const dir = process.env.HERDR_ATTACH_TEST_DIR;
const plan = JSON.parse(readFileSync(join(dir, "plan.json"), "utf8"));
const log = (event) => appendFileSync(join(dir, "events.jsonl"), JSON.stringify(event) + "\n");
const count = join(dir, "count");
const attempt = (existsSync(count) ? Number(readFileSync(count, "utf8")) : 0) + 1;
writeFileSync(count, String(attempt));
const step = plan.steps[Math.min(attempt - 1, plan.steps.length - 1)];
log({ type: "start", attempt, pid: process.pid, host: process.ppid, args: process.argv.slice(2) });
const waitForGate = async (name) => {
  const gate = name.replace("{attempt}", String(attempt));
  const deadline = Date.now() + 15000;
  while (!existsSync(join(dir, gate))) {
    if (Date.now() >= deadline) throw new Error("attach gate timed out: " + gate);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};
if (step.gate) await waitForGate(step.gate);
if (step.kind === "real") {
  const child = spawn(plan.herdr, process.argv.slice(2), { stdio: "inherit" });
  log({ type: "child", attempt, pid: child.pid });
  child.on("exit", (code) => { log({ type: "exit", attempt }); process.exitCode = code ?? 1; });
} else if (step.kind === "eof") {
  await new Promise((resolve) => process.stdout.write(step.text ?? "attached and ready\r\n", resolve));
  log({ type: "streaming", attempt });
  if (step.exitGate) await waitForGate(step.exitGate);
  log({ type: "exit", attempt });
  process.exitCode = 0;
} else {
  const message = step.kind === "held"
    ? "terminal attach failed: terminal term_test already has an attached client; retry with --takeover"
    : "terminal attach failed: terminal term_test has a read in progress; retry";
  const text = step.kind === "failed" ? "terminal attach taken over\r\n"
    // attached (its screen showing herdr's read-race words), then displaced: herdr 0.9's teardown and diagnostic
    : step.kind === "taken" ? "pane text: has a read in progress; retry\r\n\x1b[?1049l\x1b[?25h\x1b[0 qherdr: server shut down: terminal attach taken over\r\n"
    : "herdr: server shut down: " + message + "\r\n";
  process.stdout.write(text, () => {
    log({ type: "exit", attempt });
    process.exitCode = 1;
  });
}
