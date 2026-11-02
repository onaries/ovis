import { expect, it } from "bun:test";
import { codexRestartArgs } from "./codex-restart-args.ts";

it("retains explicit model and provider settings without replaying the original prompt", () => {
  expect(codexRestartArgs(["/usr/bin/codex", "-c", 'model_provider="local"', "--model", "sol", "--no-alt-screen", "An old user request"], "current"))
    .toEqual(["-c", 'model_provider="local"', "--model", "sol", "--no-alt-screen", "resume", "current"]);
});

it("replaces an old resume selection with the proven current conversation", () => {
  expect(codexRestartArgs(["node", "/opt/codex.js", "resume", "old-session", "--profile=work", "--last", "--all", "Old follow-up prompt"], "current"))
    .toEqual(["--profile=work", "resume", "current"]);
});

it("does not confuse an option's value with a headless subcommand", () => {
  expect(codexRestartArgs(["codex", "--profile", "app-server"], "current")).toEqual(["--profile", "app-server", "resume", "current"]);
});

for (const command of ["app-server", "exec", "review", "mcp-server", "help"]) {
  it(`refuses to restart a ${command} process`, () => {
    expect(codexRestartArgs(["codex", command], "current")).toBeNull();
  });
}

for (const args of [["--worktree"], ["--ephemeral"], ["--image", "old.png"], ["--unknown"], ["--model"], ["--help"], ["--version"]]) {
  it(`refuses a launch that cannot safely preserve ${args[0]}`, () => {
    expect(codexRestartArgs(["codex", ...args], "current")).toBeNull();
  });
}
