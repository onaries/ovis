import { describe, expect, it } from "bun:test";
import type { ConversationPart } from "../../shared/protocol.ts";
import { repositoryTurnPath, turnChangedFiles } from "./turnChangedFiles.ts";

const tool = (name: string, input: string, error = false): ConversationPart => ({
  kind: "tool", name, input, error, output: "", summary: "Agent narration",
});

describe("turnChangedFiles", () => {
  it("collects edit paths in call order without reads, failures, todos or duplicates", () => {
    expect(turnChangedFiles([
      tool("Read", '{"file_path":"read.ts"}'),
      tool("Edit", '{"file_path":"src/a.ts"}'),
      tool("MultiEdit", '{"file_path":"src/a.ts","edits":[]}'),
      tool("write", '{"path":"new.md"}'),
      tool("NotebookEdit", '{"notebook_path":"analysis.ipynb"}'),
      tool("Edit", '{"file_path":"failed.ts"}', true),
      tool("TodoWrite", '{"path":"todo.md"}'),
      tool("mcp__write", '{"path":"unknown.md"}'),
      { kind: "text", text: "Edited prose.md" },
    ])).toEqual(["src/a.ts", "new.md", "analysis.ipynb"]);
  });

  it("names patch additions, deletions and both sides of moves, including exec patches", () => {
    const patch = "*** Begin Patch\n*** Update File: old.ts\n*** Move to: new.ts\n@@\n-a\n+b\n*** Add File: added.ts\n+x\n*** Delete File: deleted.ts\n*** End Patch";
    expect(turnChangedFiles([tool("apply_patch", patch)])).toEqual(["old.ts", "added.ts", "deleted.ts", "new.ts"]);
    expect(turnChangedFiles([tool("exec", `await tools.apply_patch(${JSON.stringify(patch)})`)])).toEqual(["old.ts", "added.ts", "deleted.ts", "new.ts"]);
    expect(turnChangedFiles([tool("exec", `const patch = ${JSON.stringify(patch)}; text(await tools.apply_patch(patch));`)])).toEqual(["old.ts", "added.ts", "deleted.ts", "new.ts"]);
    expect(turnChangedFiles([tool("apply_patch", JSON.stringify({ patch }))])).toEqual(["old.ts", "added.ts", "deleted.ts", "new.ts"]);
  });

  it("ignores missing or malformed arguments and never infers a path from summaries", () => {
    expect(turnChangedFiles([tool("Edit", "{"), tool("Write", "null"), tool("Edit", '{"path":12}'), tool("Write", '{"path":"  "}'), tool("Bash", '{"command":"echo hello"}')])).toEqual([]);
  });
});

describe("repositoryTurnPath", () => {
  it("resolves absolute and pane-relative paths against the repository root", () => {
    expect(repositoryTurnPath({ path: "/repo/src/a.ts", cwd: "/repo/src", root: "/repo" })).toBe("src/a.ts");
    expect(repositoryTurnPath({ path: "../README.md", cwd: "/repo/src", root: "/repo" })).toBe("README.md");
    expect(repositoryTurnPath({ path: "./a.ts", cwd: "/repo/src", root: "/repo" })).toBe("src/a.ts");
    expect(repositoryTurnPath({ path: "a.ts", cwd: null, root: "/repo" })).toBe("a.ts");
  });

  it("handles Windows separators without accepting a sibling or escaped path", () => {
    expect(repositoryTurnPath({ path: "C:\\Repo\\src\\a.ts", cwd: "c:\\repo", root: "c:\\repo" })).toBe("src/a.ts");
    expect(repositoryTurnPath({ path: "/repo-other/a.ts", cwd: "/repo", root: "/repo" })).toBeNull();
    expect(repositoryTurnPath({ path: "../outside.ts", cwd: "/repo", root: "/repo" })).toBeNull();
    expect(repositoryTurnPath({ path: "~/a.ts", cwd: "/repo", root: "/repo" })).toBeNull();
  });
});
