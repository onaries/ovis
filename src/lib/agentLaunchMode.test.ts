import { expect, it } from "bun:test";

import { CLAUDE_EFFORTS, CODEX_EFFORTS, firstPromptDelivery, launchAgent, launchArgs, launchCapabilities, launchChoiceFault, modelSuggestions } from "./agentLaunchMode.ts";

const plain = { claudeLaunchMode: "default", codexLaunchMode: "default" } as const;

it("adds nothing while both modes follow the agent's own configuration", () => {
  expect(launchArgs("claude", plain)).toBeUndefined();
  expect(launchArgs("codex", plain)).toBeUndefined();
  expect(launchAgent("claude", plain)).toEqual({ kind: "claude" });
});

it("starts Claude Code with its permission mode", () => {
  expect(launchArgs("claude", { ...plain, claudeLaunchMode: "plan" })).toEqual(["--permission-mode", "plan"]);
  expect(launchAgent("claude", { ...plain, claudeLaunchMode: "bypassPermissions" })).toEqual({ kind: "claude", args: ["--permission-mode", "bypassPermissions"] });
});

it("starts Codex with a sandbox and an approval policy together", () => {
  expect(launchArgs("codex", { ...plain, codexLaunchMode: "readOnly" })).toEqual(["--sandbox", "read-only", "--ask-for-approval", "on-request"]);
  expect(launchArgs("codex", { ...plain, codexLaunchMode: "auto" })).toEqual(["--sandbox", "workspace-write", "--ask-for-approval", "on-request"]);
  expect(launchArgs("codex", { ...plain, codexLaunchMode: "fullAccess" })).toEqual(["--sandbox", "danger-full-access", "--ask-for-approval", "never"]);
});

it("leaves other agents and a plain shell alone", () => {
  const set = { claudeLaunchMode: "plan", codexLaunchMode: "fullAccess" } as const;
  expect(launchArgs("omp", set)).toBeUndefined();
  expect(launchAgent("copilot", set, { prompt: "Fix it" })).toEqual({ kind: "copilot" });
  expect(firstPromptDelivery("copilot", "Fix it")).toBe("pending");
  expect(launchAgent("gemini", set)).toEqual({ kind: "gemini" });
  expect(launchAgent("", set)).toBeNull();
});

it("names a model and an effort for the agents whose CLI documents them, and a positional prompt only where the separator makes it safe", () => {
  // Claude Code's parser runs a subcommand named by the first operand even after `--` (claude -- update ran the updater)
  expect(launchCapabilities("claude")).toEqual({ model: true, efforts: CLAUDE_EFFORTS, positionalPrompt: false });
  // clap takes everything after `--` as the PROMPT positional (codex -- logout started the TUI)
  expect(launchCapabilities("codex")).toEqual({ model: true, efforts: CODEX_EFFORTS, positionalPrompt: true });
  // Letta Code takes a prompt only with `-p`, its headless mode (letta-code 0.34.23, src/cli/args.ts)
  for (const kind of ["omp", "pi", "gemini", "opencode", "letta", ""]) expect(launchCapabilities(kind)).toEqual({ model: false, efforts: [], positionalPrompt: false });
  expect(modelSuggestions("claude")).toEqual(["sonnet", "opus", "haiku"]);
  expect(modelSuggestions("codex")).toEqual([]);
});

it("puts the model, the effort and then the prompt after the mode, each in the agent's own syntax", () => {
  // Claude Code's prompt is never on its command line: the mode, model and effort go, the message waits for the bridge
  expect(launchArgs("claude", { ...plain, claudeLaunchMode: "plan" }, { model: "opus", effort: "high", prompt: "Fix the flaky test" }))
    .toEqual(["--permission-mode", "plan", "--model", "opus", "--effort", "high"]);
  // Codex's prompt comes last, after the end-of-options separator
  expect(launchArgs("codex", plain, { model: "gpt-5-codex", effort: "xhigh", prompt: " Review the branch " }))
    .toEqual(["--model", "gpt-5-codex", "-c", "model_reasoning_effort=xhigh", "--", "Review the branch"]);
  expect(launchAgent("codex", plain, { prompt: "$review-pr" })).toEqual({ kind: "codex", args: ["--", "$review-pr"] });
  // a message that names a subcommand or a flag is still the prompt behind the separator
  for (const prompt of ["logout", "update", "--help", "-p x"]) expect(launchArgs("codex", plain, { prompt })).toEqual(["--", prompt]);
  // nothing chosen adds nothing
  expect(launchArgs("codex", plain, { model: "  ", effort: "", prompt: "" })).toBeUndefined();
});

it("refuses a choice the launch does not take, and a model that would read as a flag", () => {
  expect(launchChoiceFault("claude", { model: "opus", effort: "max", prompt: "hi" })).toBeNull();
  expect(launchChoiceFault("omp", { model: "", effort: "", prompt: "hi" })).toBeNull();
  expect(launchChoiceFault("omp", { model: "gpt-5" })).toBe("model");
  expect(launchChoiceFault("omp", { effort: "high" })).toBe("effort");
  expect(launchChoiceFault("codex", { effort: "ultracode" })).toBe("effort");
  expect(launchChoiceFault("claude", { model: "--dangerously-skip-permissions" })).toBe("model");
  expect(launchChoiceFault("claude", { model: "two words" })).toBe("model");
  expect(launchChoiceFault("", { prompt: "a shell takes none" })).toBe("prompt");
  // what the fault refuses, the launch never passes
  expect(launchArgs("omp", plain, { model: "gpt-5", effort: "high" })).toBeUndefined();
  expect(launchArgs("claude", plain, { model: "--dangerously-skip-permissions" })).toBeUndefined();
});

it("sends the first prompt as Codex's own argument, and as the bridge's pending message for every other agent", () => {
  expect(firstPromptDelivery("codex", "Fix it")).toBe("positional");
  expect(firstPromptDelivery("codex", "-v tell me")).toBe("positional");
  expect(firstPromptDelivery("claude", "Fix it")).toBe("pending");
  expect(firstPromptDelivery("omp", "Fix it")).toBe("pending");
  expect(firstPromptDelivery("opencode", "Fix it")).toBe("pending");
  expect(launchArgs("claude", plain, { prompt: "Fix it" })).toBeUndefined();
  expect(firstPromptDelivery("codex", "   ")).toBeNull();
  expect(firstPromptDelivery("", "Fix it")).toBeNull();
});
