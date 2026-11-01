import { availableParallelism } from "node:os";
import { existsSync } from "node:fs";

export {};

// Native TypeScript uses Go's GC. Trade some RAM for CPU without disabling collection
// across concurrent CI runners, and bound its scheduler width on large hosts.
// Caller settings, including GOMEMLIMIT, stay in force.
const env = {
  ...process.env,
  GOGC: process.env["GOGC"] ?? "400",
  GOMAXPROCS: process.env["GOMAXPROCS"] ?? String(Math.min(32, availableParallelism())),
};

// Build the vendor boundary first: importing it must not recheck upstream sources
// with the application's noUncheckedIndexedAccess policy.
const vendor = "shared/vendor/paseo-e2ee/tsconfig.json";
if (existsSync(vendor)) {
  const child = Bun.spawn([process.execPath, "--bun", "tsc", "-p", vendor, "--emitDeclarationOnly"], {
    env, stdin: "inherit", stdout: "inherit", stderr: "inherit",
  });
  const code = await child.exited;
  if (code !== 0) process.exit(code);
}

for (const args of [[], ["-p", "tsconfig.tools.json"]]) {
  const child = Bun.spawn([process.execPath, "--bun", "tsc", "--noEmit", ...args], {
    env, stdin: "inherit", stdout: "inherit", stderr: "inherit",
  });
  const code = await child.exited;
  if (code !== 0) process.exit(code);
}
