import { availableParallelism } from "node:os";

export {};

// Native TypeScript uses Go's GC. Trade some RAM for CPU without disabling collection
// across concurrent CI runners, and bound its scheduler width on large hosts.
// Caller settings, including GOMEMLIMIT, stay in force.
const env = {
  ...process.env,
  GOGC: process.env["GOGC"] ?? "400",
  GOMAXPROCS: process.env["GOMAXPROCS"] ?? String(Math.min(32, availableParallelism())),
};

for (const args of [[], ["-p", "tsconfig.tools.json"]]) {
  const child = Bun.spawn([process.execPath, "--bun", "tsc", "--noEmit", ...args], {
    env, stdin: "inherit", stdout: "inherit", stderr: "inherit",
  });
  const code = await child.exited;
  if (code !== 0) process.exit(code);
}
