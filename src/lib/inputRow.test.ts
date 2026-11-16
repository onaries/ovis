import { describe, expect, test } from "bun:test";
import { Terminal } from "@xterm/xterm";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { FrameGate, inputRowState, readScreen, readScreenLines, readsInputRow, type InputRowState, type ScreenSnapshot } from "./inputRow.ts";
import { matchHerdrWidths } from "./terminalWidths.ts";
import { drawsColour, screenFromAnsi, typedDraft } from "../../shared/input-row.ts";
import { SCREEN_AUTO_RETURN, watchReturn } from "./terminalPeek.ts";

// Recorded screens and frames (src/lib/fixtures-input-rows/README.md; kept out of server/ so remote bundles do not carry them), fed through the real xterm
// buffer: the adapter (readScreen) is the one the pane uses.
const FIXTURES = join(import.meta.dir, "fixtures-input-rows");
const CLAUDE = join(import.meta.dir, "../../server/fixtures");

const parse = (term: Terminal, data: string): Promise<void> => new Promise((resolve) => term.write(data, resolve));
const terminal = (cols: number, rows = 40): Terminal => {
  const term = new Terminal({ cols, rows, scrollback: 0, allowProposedApi: true });
  matchHerdrWidths(term);
  return term;
};

test("logical screen lines preserve spaces across wraps but not hard line breaks", async () => {
  const term = terminal(40, 5);
  const text = `${"a".repeat(39)} b`;
  try {
    await parse(term, `${text}\r\nnext`);
    expect(readScreenLines(term.buffer.active, term.rows)).toEqual([text, "next", "", ""]);
  } finally {
    term.dispose();
  }
});

test("logical screen lines reject a wrapped line clipped at the screen top", async () => {
  const term = terminal(40, 2);
  try {
    await parse(term, `${"a".repeat(81)}\r\nnext`);
    expect(readScreenLines(term.buffer.active, term.rows)).toBeNull();
  } finally {
    term.dispose();
  }
});

/** A static recording (one row per line, SGR only) as the screen shows it. */
async function screenOf(text: string, cols: number): Promise<ScreenSnapshot> {
  const term = terminal(cols);
  const rows = text.replace(/\r/g, "").split("\n").slice(0, 40);
  await parse(term, rows.map((row, index) => `\u001b[${index + 1};1H${row}`).join(""));
  const screen = readScreen(term.buffer.active, term.cols, term.rows);
  term.dispose();
  return screen;
}
const columnsOf = (name: string): number => Number(/-(\d+)\.(?:ansi|txt)$/.exec(name)![1]);
async function recorded(agent: string, name: string): Promise<InputRowState | null> {
  const file = `${name}.ansi`;
  return inputRowState(agent, await screenOf(readFileSync(join(FIXTURES, agent, file), "utf8"), columnsOf(file)));
}

/** A recorded frame stream replayed through the pane's frame gate, each frame cut in two as a read can cut it. */
async function replay(agent: string, name: string): Promise<(InputRowState | null)[]> {
  const frames = readFileSync(join(FIXTURES, agent, `${name}.frames.jsonl`), "utf8").trim().split("\n")
    .map((line) => JSON.parse(line) as { cols: number; rows: number; data: string });
  const term = terminal(frames[0]!.cols, frames[0]!.rows);
  const gate = new FrameGate();
  term.onResize(() => gate.resized());
  const states: (InputRowState | null)[] = [];
  for (const frame of frames) {
    if (frame.cols !== term.cols || frame.rows !== term.rows) term.resize(frame.cols, frame.rows);
    const cut = Math.floor(frame.data.length / 2);
    for (const part of [frame.data.slice(0, cut), frame.data.slice(cut)]) {
      const stamp = gate.enqueue(part, true);
      await parse(term, part);
      // the first half of a frame never reads: its block is still open
      if (gate.settle(stamp, true)) states.push(inputRowState(agent, readScreen(term.buffer.active, term.cols, term.rows)));
      else expect(part).toBe(frame.data.slice(0, cut));
    }
  }
  term.dispose();
  return states;
}

/** The watched peek over a run of frames: where it stands at the end, and at which frame it came back. */
function watch(agent: string, states: readonly (InputRowState | null)[]): { armed: boolean; returnedAt: number | null; manualAt: number | null } {
  let armed = false;
  for (const [index, state] of states.entries()) {
    if (state === null) continue;
    const step = watchReturn(agent, armed, state);
    if (step.step === "return") return { armed, returnedAt: index, manualAt: null };
    if (step.step === "manual") return { armed, returnedAt: null, manualAt: index };
    armed = step.armed;
  }
  return { armed, returnedAt: null, manualAt: null };
}

// What each recorded screen shows of the agent's input row: idle and closed are ready, every screen
// an allow-listed command opens is not (gone, or covered where the row stays drawn under it).
const EXPECTED: Record<string, Record<string, InputRowState>> = {
  // the still-open guard's reported case: /btw's answer, recorded on Claude Code 2.1.308 under both renderers
  claude: {
    "btw-open-119": "gone", "btw-closed-119": "ready", "btw-open-fullscreen-119": "gone", "btw-closed-fullscreen-119": "ready",
  },
  codex: {
    "permissions-idle-120": "ready", "permissions-idle-40": "ready", "permissions-open-120": "gone", "permissions-open-40": "gone",
    "permissions-closed-120": "ready", "permissions-closed-40": "ready",
    // picker rows that start like the composer
    "theme-open-120": "gone", "theme-open-40": "gone", "statusline-open-120": "gone", "statusline-open-40": "gone",
    // /rename's field has the empty composer's very cells: its footer tells it apart
    "rename-open-120": "gone", "rename-open-40": "gone", "rename-closed-40": "ready",
    // the /diff pager: Escape does nothing, q closes it
    "diff-open-120": "gone", "diff-open-40": "gone", "diff-closed-120": "gone", "diff-closed-q-120": "ready", "diff-closed-q-40": "ready",
    "cd-untrusted-repo-open-120": "gone", "cd-untrusted-repo-open-40": "gone", "cd-untrusted-repo-closed-120": "ready",
    // /mention leaves `@` in the composer
    "mention-closed-120": "draft",
  },
  omp: {
    "settings-idle-119": "ready", "settings-idle-40": "ready", "settings-open-119": "gone", "settings-open-40": "gone",
    "settings-closed-119": "ready", "settings-closed-40": "ready",
    // /context's `⎋ to close` box over a status bar and an editor that both stay drawn at 119 columns
    "context-open-119": "covered", "context-open-40": "gone", "context-closed-119": "ready",
    "btw-open-119": "gone", "btw-open-40": "gone", "switch-open-119": "gone",
    // /plan prints and keeps the editor: never armed, it stays manual
    "plan-open-119": "ready",
    // omp 18.14 drops the status bar's frame: the peek (18.8.7's shape) does not make it out; the draft check does
    "draft-empty-119": "gone", "draft-typed-119": "gone", "draft-lines-119": "gone", "draft-slash-119": "gone",
  },
  pi: {
    // the chat send's draft check (shared/input-row.ts typedDraft): pi 1.4.0 recorded empty, typed into, with autocomplete open
    "draft-empty-119": "ready", "draft-typed-119": "draft", "draft-slash-119": "gone",
    "settings-idle-119": "ready", "settings-idle-40": "ready", "settings-open-119": "gone", "settings-open-40": "gone",
    "settings-closed-119": "ready", "settings-closed-40": "ready",
    "tree-open-119": "gone", "tree-open-40": "gone", "resume-open-119": "gone", "resume-open-40": "gone",
    "scoped-models-open-119": "gone", "scoped-models-open-40": "gone",
    // printed under the editor, which stays
    "hotkeys-open-119": "ready",
  },
  gjc: {
    "settings-idle-119": "ready", "settings-idle-40": "ready", "settings-open-119": "gone", "settings-open-40": "gone",
    "settings-closed-119": "ready", "settings-closed-40": "ready",
    "model-open-119": "gone", "model-open-40": "gone", "transcript-open-119": "gone", "transcript-open-40": "gone",
    // /sessions keeps the empty box for 10 to 15 s before its list draws
    "sessions-open-early-119": "ready", "sessions-open-loading10s-119": "ready", "sessions-closed-119": "ready",
    "session-delete-after-first-enter-119": "draft",
    // the chat send's draft check: gjc 0.18.12 in the agent lab, empty, typed into, `/mo` typed with its command list open
    "draft-empty-119": "ready", "draft-typed-119": "draft", "draft-slash-119": "draft",
  },
  omo: {
    // the chat send's draft check (shared/input-row.ts typedDraft): OmO 5.1.69 recorded empty, typed into, with autocomplete open
    "draft-empty-119": "ready", "draft-typed-119": "draft", "draft-slash-119": "gone",
    "settings-idle-119": "ready", "settings-idle-40": "ready", "settings-open-119": "gone", "settings-open-40": "gone",
    "settings-closed-119": "ready", "settings-closed-40": "ready",
    // dialogs draw a bare `>` under one rule
    "rename-open-119": "gone", "rename-open-40": "gone", "trust-open-119": "gone", "trust-open-40": "gone", "share-open-119": "gone",
    "btw-open-119": "ready", "btw-typed-autocomplete-119": "draft",
  },
  hermes: {
    "model-idle-120": "ready", "model-idle-40": "ready", "model-closed-120": "ready", "model-closed-40": "ready",
    // the picker and the palette hide the status bar over an empty row; a confirmation replaces the row
    "model-open-120": "covered", "model-open-40": "covered", "palette-open-120": "covered",
    "reload-mcp-open-120": "covered", "reload-mcp-open-40": "covered", "reload-mcp-closed-120": "ready", "reload-mcp-closed-40": "ready",
    "new-open-120": "covered", "new-open-40": "covered", "clear-open-120": "covered",
    // Escape puts `/palette` back in the row; /prompt hands the screen to $EDITOR
    "palette-closed-40": "draft", "prompt-open-120": "gone",
  },
  devin: {
    "model-idle-119": "ready", "model-idle-40": "ready", "model-open-119": "gone", "model-open-40": "gone",
    "model-closed-119": "ready", "model-closed-40": "ready",
    // /btw's own field: a labelled top rule, `❭ Ask a /btw…`, `esc back to chat`
    "btw-open-119": "gone", "btw-open-40": "gone", "btw-closed-119": "ready",
    "config-open-119": "gone", "config-open-40": "gone",
  },
  agy: {
    "model-idle-119": "ready", "model-idle-40": "ready", "model-closed-119": "ready", "model-closed-40": "ready",
    // its panels draw under an empty box; /codesearch even keeps `? for shortcuts` last
    "model-open-119": "covered", "model-open-40": "covered", "config-open-119": "covered", "config-open-40": "covered",
    "codesearch-open-119": "covered", "codesearch-open-40": "covered",
    "diff-open-119": "gone", "diff-open-40": "gone", "changelog-open-119": "gone",
    // /open's first Enter only takes the completion
    "open-open-119": "draft",
  },
  grok: {
    // before the first key the welcome card and `[stable]` footer stand: not ready
    "settings-idle-119": "covered", "help-idle-40": "ready",
    "settings-open-119": "covered", "settings-open-40": "gone", "settings-closed-119": "ready", "settings-closed-40": "ready",
    // the Agent Dashboard's own field, /history's search row
    "sessions-open-119": "gone", "sessions-open-40": "gone", "history-open-119": "gone", "history-open-40": "gone",
    "help-open-119": "covered",
    // Escape leaves `/model` in the row
    "model-closed-119": "draft",
  },
};

describe("inputRowState on recorded screens", () => {
  for (const [agent, screens] of Object.entries(EXPECTED)) {
    test(`${agent}: idle and closed are ready, an open screen is not`, async () => {
      const found: Record<string, InputRowState | null> = {};
      for (const name of Object.keys(screens)) found[name] = await recorded(agent, name);
      expect(found).toEqual(screens);
    });
  }

  test("every recorded screen is listed above", () => {
    const listed = Object.entries(EXPECTED).flatMap(([agent, screens]) => Object.keys(screens).map((name) => `${agent}/${name}.ansi`)).sort();
    // the peek's agents; the draft check's own boxes (shared/input-row.ts typedDraft) are tested below
    const files = readdirSync(FIXTURES).filter((agent) => readsInputRow(agent)).flatMap((agent) =>
      readdirSync(join(FIXTURES, agent)).filter((file) => file.endsWith(".ansi")).map((file) => `${agent}/${file}`)).sort();
    expect(files).toEqual(listed);
  });

  test("Claude Code's box (server/prompt.ts claudeInputBox): ready under its rules, gone under a panel", async () => {
    const claude = readdirSync(CLAUDE).filter((file) => file.startsWith("claude-") && file.endsWith(".txt"));
    const found = Object.fromEntries(await Promise.all(claude.map(async (file) =>
      [file, inputRowState("claude", await screenOf(readFileSync(join(CLAUDE, file), "utf8"), columnsOf(file)))] as const)));
    // the /effort dialog after `s`: closed, its result above the box
    const ready = ["claude-effort-2.1.311-set-120.txt", "claude-rewind-2.1.304-closed-40.txt", "claude-rewind-2.1.304-confirm-apple-esc-esc-120.txt", "claude-rewind-2.1.304-confirm-apple-esc-esc-40.txt"];
    expect(claude.length).toBeGreaterThan(10);
    for (const file of claude) expect([file, found[file]]).toEqual([file, ready.includes(file) ? "ready" : "gone"]);
  });

  test("Claude Code's grey text, cursor and IDE pill are no draft; typed text and pastes are", async () => {
    const rule = "─".repeat(60);
    const grey = (text: string): string => `\u001b[2m${text}\u001b[22m`;
    const box = (row: string): Promise<ScreenSnapshot> => screenOf(["● earlier output", "", rule, row, rule, "  ? for shortcuts"].join("\n"), 60);
    const pill = "[⧉ 3 lines selected] ";
    expect(inputRowState("claude", await box("❯ "))).toBe("ready");
    expect(inputRowState("claude", await box(`❯ ${grey("run the tests again")}`))).toBe("ready");
    expect(inputRowState("claude", await box(`❯ \u001b[7m${grey("r")}\u001b[27m${grey("un the tests again")}`))).toBe("ready");
    expect(inputRowState("claude", await box(`❯ ${pill}`))).toBe("ready");
    expect(inputRowState("claude", await box(`❯ ${pill}${grey("run the tests again")}`))).toBe("ready");
    expect(inputRowState("claude", await box("❯ still typing"))).toBe("draft");
    expect(inputRowState("claude", await box(`❯ ${pill}typed`))).toBe("draft");
    expect(inputRowState("claude", await box(grey("❯ [Pasted text #1 +12 lines]")))).toBe("draft");
    // a cursor over a typed character has nothing grey after it
    expect(inputRowState("claude", await box("❯ \u001b[7mx\u001b[27m"))).toBe("draft");
    expect(inputRowState("claude", await box("! ls"))).toBe("draft");
    // NO_COLOR: the tip as the box's one row, on a screen without any colour, is Claude's own
    expect(inputRowState("claude", await box('❯ \u001b[7mT\u001b[27mry "refactor this function"'))).toBe("ready");
    expect(inputRowState("claude", await box("❯ Try this instead"))).toBe("draft");
    // a named session labels its rule
    expect(inputRowState("claude", await screenOf([`── my-session ${"─".repeat(40)}`, "❯ ", rule, "  ? for shortcuts"].join("\n"), 60))).toBe("ready");
    // a picker's `❯ 1.` choice is no box, nor is a screen without rules
    expect(inputRowState("claude", await box("❯ 1. Yes"))).toBe("draft");
    expect(inputRowState("claude", await screenOf("  Side question\n\n  Press Space, Enter, or Escape to dismiss", 60))).toBe("gone");
  });

  test("Codex at Ultra reasoning effort marks its composer »: the same row, read the same way", async () => {
    // recorded on Codex 0.167.0 (fixtures-input-rows/codex-0.167.0): the composer after /model's Ultra row, empty, with a draft, and under its shortcuts
    const ultra = (name: string): Promise<ScreenSnapshot> => screenOf(readFileSync(join(FIXTURES, "codex-0.167.0", `${name}.ansi`), "utf8"), columnsOf(`${name}.ansi`));
    expect(inputRowState("codex", await ultra("composer-ultra-empty-100"))).toBe("ready");
    expect(inputRowState("codex", await ultra("composer-ultra-empty-40"))).toBe("ready");
    expect(inputRowState("codex", await ultra("composer-ultra-draft-100"))).toBe("draft");
    // a numbered row under either mark is a list's choice, not the composer (0.163's /permissions, its cursor's mark swapped)
    const swapped = readFileSync(join(FIXTURES, "codex", "permissions-open-120.ansi"), "utf8").replace("›", "»");
    expect(inputRowState("codex", await screenOf(swapped, 120))).toBe("gone");
  });

  test("a blank screen says nothing, and an agent without a recognizer is not read", async () => {
    const blank = await screenOf("", 40);
    expect(inputRowState("codex", blank)).toBe("unknown");
    expect(inputRowState("claude", blank)).toBe("unknown");
    expect(inputRowState("opencode", blank)).toBeNull();
    expect(inputRowState(null, blank)).toBeNull();
    expect(readsInputRow("opencode")).toBe(false);
    expect(readsInputRow("toString")).toBe(false);
    for (const agent of [...Object.keys(SCREEN_AUTO_RETURN), "claude"]) expect(readsInputRow(agent)).toBe(true);
  });
});

describe("FrameGate", () => {
  const OPEN = "\u001b[?2026h";
  const CLOSE = "\u001b[?2026l";

  test("reads a frame only once its synchronized block has closed, however a read cut it", () => {
    const gate = new FrameGate();
    const first = gate.enqueue(`${OPEN}\u001b[1;1Hhalf`, true);
    expect(gate.settle(first, true)).toBe(false);
    expect(gate.current).toBe(false);
    // the closing sequence itself cut in two
    const second = gate.enqueue(" a frame\u001b[?20", true);
    expect(gate.settle(second, true)).toBe(false);
    const third = gate.enqueue(`26l`, true);
    expect(gate.settle(third, true)).toBe(true);
    expect(gate.current).toBe(true);
  });

  test("after a resize, only a whole frame written for the new grid reads", () => {
    const gate = new FrameGate();
    expect(gate.settle(gate.enqueue(`${OPEN}idle${CLOSE}`, true), true)).toBe(true);
    // queued before the resize, parsed after it: drawn for the old grid
    const queued = gate.enqueue(`${OPEN}old${CLOSE}`, true);
    gate.resized();
    expect(gate.current).toBe(false);
    expect(gate.settle(queued, true)).toBe(false);
    // written before the pane's grid said it was this size
    expect(gate.settle(gate.enqueue(`${OPEN}old size${CLOSE}`, false), true)).toBe(false);
    // the tail of a frame opened before the resize
    const opened = gate.enqueue(`${OPEN}redraw`, true);
    expect(gate.settle(opened, true)).toBe(false);
    gate.resized();
    expect(gate.settle(gate.enqueue(`rest${CLOSE}`, true), true)).toBe(false);
    // a whole frame for the new grid; after it, any chunk at a frame's end reads
    expect(gate.settle(gate.enqueue(`${OPEN}new${CLOSE}`, true), true)).toBe(true);
    expect(gate.settle(gate.enqueue("\u001b[1;1Hmore", true), true)).toBe(true);
    // a stream that is not current (recovering, a grid changed since) never reads
    expect(gate.settle(gate.enqueue(`${OPEN}x${CLOSE}`, true), false)).toBe(false);
  });

  test("a stream drawn without blocks (a mirrored pane's whole screens) reads each chunk", () => {
    const gate = new FrameGate();
    expect(gate.settle(gate.enqueue("\u001b[2J\u001b[Hscreen", true), true)).toBe(true);
    gate.resized();
    expect(gate.settle(gate.enqueue("\u001b[2J\u001b[Hscreen", true), true)).toBe(true);
  });

  test("a reset forgets a block the old stream left open", () => {
    const gate = new FrameGate();
    gate.enqueue(`${OPEN}cut off`, true);
    gate.reset();
    expect(gate.settle(gate.enqueue(`${OPEN}fresh${CLOSE}`, true), true)).toBe(true);
  });

  test("when the pane's grid changes size, its first frame (maybe herdr's reflow of the old screen) reads but is marked", () => {
    const gate = new FrameGate();
    expect(gate.settle(gate.enqueue(`${OPEN}idle${CLOSE}`, true), true)).toBe(true);
    expect(gate.reflowing).toBe(false);
    // pane-geometry with a new size, then this terminal's grid follows it
    gate.reflowed();
    expect(gate.current).toBe(false);
    gate.resized();
    expect(gate.settle(gate.enqueue(`${OPEN}old screen, reflowed${CLOSE}`, true), true)).toBe(true);
    expect(gate.reflowing).toBe(true);
    expect(gate.settle(gate.enqueue(`${OPEN}the agent's redraw${CLOSE}`, true), true)).toBe(true);
    expect(gate.reflowing).toBe(false);
    // the grid this terminal drives: its own resize first, the pane's grid after
    gate.resized();
    expect(gate.settle(gate.enqueue(`${OPEN}before the pane's size${CLOSE}`, false), true)).toBe(false);
    gate.reflowed();
    expect(gate.settle(gate.enqueue(`${OPEN}old screen, reflowed${CLOSE}`, true), true)).toBe(true);
    expect(gate.reflowing).toBe(true);
    // a chunk cut inside the next frame is not current, nor reflowing
    expect(gate.settle(gate.enqueue(`${OPEN}half`, true), true)).toBe(false);
    expect(gate.reflowing).toBe(false);
    // a stream that starts over has no reflow of its own
    gate.reflowed();
    gate.reset();
    expect(gate.settle(gate.enqueue(`${OPEN}fresh${CLOSE}`, true), true)).toBe(true);
    expect(gate.reflowing).toBe(false);
  });
});

describe("recorded frame streams", () => {
  test("Codex /permissions at 40 columns: the send hides the row, the close draws it back in one frame", async () => {
    const sent = await replay("codex", "permissions-send-40");
    expect(sent).toEqual(["ready", "draft", "gone"]);
    expect(watch("codex", sent)).toEqual({ armed: true, returnedAt: null, manualAt: null });
    const closed = await replay("codex", "permissions-closing-40");
    expect(closed).toEqual(["gone", "ready"]);
    expect(watch("codex", closed)).toEqual({ armed: true, returnedAt: 1, manualAt: null });
  });

  test("Codex /diff: an empty composer drawn before the pager never arms or returns", async () => {
    const sent = await replay("codex", "diff-send-120");
    expect(sent).toEqual(["ready", "draft", "ready", "gone"]);
    expect(watch("codex", sent)).toEqual({ armed: true, returnedAt: null, manualAt: null });
  });

  test("Codex /cd's trust screen closes through one blank frame", async () => {
    const closed = await replay("codex", "cd-untrusted-repo-closing-40");
    expect(closed).toEqual(["gone", "unknown", "ready"]);
    expect(watch("codex", closed)).toEqual({ armed: true, returnedAt: 2, manualAt: null });
  });

  test("agy /model at 40 columns: the empty box drawn before the panel never arms", async () => {
    const frames = await replay("agy", "model-40");
    expect(frames).toEqual(["ready", "draft", "ready", "covered", "ready"]);
    expect(watch("agy", frames)).toEqual({ armed: true, returnedAt: 4, manualAt: null });
  });

  test("Devin /btw: its own field is no input row; the close is one frame", async () => {
    const frames = await replay("devin", "btw-119");
    expect(frames).toEqual(["ready", "draft", "gone", "ready"]);
    expect(watch("devin", frames)).toEqual({ armed: true, returnedAt: 3, manualAt: null });
  });

  test("Hermes: the empty row drawn between the echo and the screen arms nothing; only a covered row does", async () => {
    // every slash command: draft, the echo (gone), the empty row with its status bar for a moment, the screen
    const sequence = [
      await recorded("hermes", "model-idle-120"), await recorded("hermes", "palette-closed-40"), await recorded("hermes", "prompt-open-120"),
      await recorded("hermes", "model-idle-120"), await recorded("hermes", "model-open-120"), await recorded("hermes", "model-closed-120"),
    ];
    expect(sequence).toEqual(["ready", "draft", "gone", "ready", "covered", "ready"]);
    expect(watch("hermes", sequence)).toEqual({ armed: true, returnedAt: 5, manualAt: null });
    // /prompt's $EDITOR hides the row and never covers it: manual
    expect(watch("hermes", sequence.slice(0, 4))).toEqual({ armed: false, returnedAt: null, manualAt: null });
  });

  test("gjc /sessions: the empty box it keeps while loading never arms", async () => {
    const sequence = [await recorded("gjc", "sessions-open-early-119"), await recorded("gjc", "sessions-open-loading10s-119"), await recorded("gjc", "sessions-closed-119")];
    expect(watch("gjc", sequence)).toEqual({ armed: false, returnedAt: null, manualAt: null });
    const loaded = [...sequence.slice(0, 2), await recorded("gjc", "settings-open-119"), await recorded("gjc", "sessions-closed-119")];
    expect(watch("gjc", loaded)).toEqual({ armed: true, returnedAt: 3, manualAt: null });
  });

  test("a phone peek's resize: herdr's reflowed frame of gjc's loading /sessions neither arms nor returns", async () => {
    const loading = readFileSync(join(FIXTURES, "gjc", "sessions-open-loading10s-119.ansi"), "utf8").replace(/\r/g, "").split("\n").slice(0, 40);
    // herdr's own frame for the new grid: the old screen, reflowed to 40 columns (its box cut at the borders)
    const old = terminal(119);
    await parse(old, loading.map((row, index) => `\u001b[${index + 1};1H${row}`).join(""));
    old.resize(40, 40);
    await parse(old, "");
    const reflowed = Array.from({ length: 40 }, (_, y) => old.buffer.active.getLine(old.buffer.active.baseY + y)!.translateToString(true));
    old.dispose();
    expect(inputRowState("gjc", await screenOf(reflowed.join("\n"), 40))).toBe("gone");
    // gjc's own redraw at 40 columns: still its empty box (the recorded one after a close stands in for it)
    const redrawn = readFileSync(join(FIXTURES, "gjc", "settings-closed-40.ansi"), "utf8").replace(/\r/g, "").split("\n").slice(0, 40);
    const frame = (rows: readonly string[]): string => `\u001b[?2026h\u001b[2J${rows.map((row, index) => `\u001b[${index + 1};1H${row}`).join("")}\u001b[?2026l`;
    const term = terminal(119);
    const gate = new FrameGate();
    term.onResize(() => gate.resized());
    // as the pane takes its frames (PaneTerminal onInputRowFrame): a reflowing one changes nothing
    const states: InputRowState[] = [];
    const write = async (data: string): Promise<void> => {
      const stamp = gate.enqueue(data, true);
      await parse(term, data);
      if (gate.settle(stamp, true) && !gate.reflowing) states.push(inputRowState("gjc", readScreen(term.buffer.active, term.cols, term.rows))!);
    };
    await write(frame(loading));
    // pane-geometry: the pty took 40 columns, and this grid follows
    gate.reflowed();
    term.resize(40, 40);
    await write(frame(reflowed));
    await write(frame(redrawn));
    term.dispose();
    expect(states).toEqual(["ready", "ready"]);
    expect(watch("gjc", states)).toEqual({ armed: false, returnedAt: null, manualAt: null });
    // read, the reflowed frame would have armed the watch and the redraw brought the chat back before the sessions opened
    expect(watch("gjc", ["ready", "gone", "ready"])).toEqual({ armed: true, returnedAt: 2, manualAt: null });
  });

  test("a screen that closes onto text in the row leaves the return to the reader", async () => {
    expect(watch("hermes", [await recorded("hermes", "palette-open-120"), await recorded("hermes", "palette-closed-40")]))
      .toEqual({ armed: true, returnedAt: null, manualAt: 1 });
    expect(watch("grok", [await recorded("grok", "settings-open-119"), await recorded("grok", "model-closed-119")]))
      .toEqual({ armed: true, returnedAt: null, manualAt: 1 });
  });

  test("omp /context at 119 columns arms on its covered editor and comes back on the closed one", async () => {
    expect(watch("omp", [await recorded("omp", "settings-idle-119"), await recorded("omp", "context-open-119"), await recorded("omp", "context-closed-119")]))
      .toEqual({ armed: true, returnedAt: 2, manualAt: null });
    // a print form keeps the editor: never armed
    expect(watch("omp", [await recorded("omp", "settings-idle-119"), await recorded("omp", "plan-open-119"), await recorded("omp", "settings-closed-119")]))
      .toEqual({ armed: false, returnedAt: null, manualAt: null });
  });
});

describe("the chat send's read of the same screens (shared/input-row.ts)", () => {
  // every recording: herdr's ANSI read, parsed on the server, reads as the xterm buffer does
  const agents = readdirSync(FIXTURES).filter((name) => !name.includes(".") && name !== "codex-0.167.0");
  const files = agents.flatMap((agent) => readdirSync(join(FIXTURES, agent)).filter((file) => file.endsWith(".ansi")).map((file) => [agent, file] as const));
  test.each(files)("%s %s", async (agent, file) => {
    const text = readFileSync(join(FIXTURES, agent, file), "utf8");
    expect(inputRowState(agent, screenFromAnsi(text))).toBe(inputRowState(agent, await screenOf(text, columnsOf(file))));
  });

  const typed = (agent: string, file: string): boolean => typedDraft(agent, screenFromAnsi(readFileSync(join(FIXTURES, file), "utf8")));

  test("text typed into the box is a draft; an empty box, a placeholder and a box not made out are not", () => {
    expect(typed("pi", "pi/draft-typed-119.ansi")).toBeTrue();
    expect(typed("omo", "omo/draft-typed-119.ansi")).toBeTrue();
    expect(typed("codex", "codex-0.167.0/composer-ultra-draft-100.ansi")).toBeTrue();
    expect(typed("codex", "codex/mention-closed-120.ansi")).toBeTrue();
    expect(typed("pi", "pi/draft-empty-119.ansi")).toBeFalse();
    expect(typed("omo", "omo/draft-empty-119.ansi")).toBeFalse();
    expect(typed("codex", "codex-0.167.0/composer-ultra-empty-100.ansi")).toBeFalse();
    // their autocomplete moves the box out of its recorded place: not made out, so not refused
    expect(typed("pi", "pi/draft-slash-119.ansi")).toBeFalse();
    expect(typed("omo", "omo/draft-slash-119.ansi")).toBeFalse();
  });

  test("pi's editor holding a line typed with leading spaces is a draft to the send, still a dialog's row to the peek", () => {
    const indented = readFileSync(join(FIXTURES, "pi/draft-typed-119.ansi"), "utf8").replace("leftover draft", "  indented snippet");
    expect(typedDraft("pi", screenFromAnsi(indented))).toBeTrue();
    expect(inputRowState("pi", screenFromAnsi(indented))).toBe("gone");
    const typedRow = (row: string): boolean => typedDraft("pi", screenFromAnsi(readFileSync(join(FIXTURES, "pi/draft-typed-119.ansi"), "utf8").replace("leftover draft", row)));
    // a draft starting with a Markdown quote or an arrow is still one
    expect(typedRow("> please retain this quote")).toBeTrue();
    expect(typedRow("→ note to self")).toBeTrue();
    // a dialog's search field typed into, over its select cursor drawn in colour, is none
    expect(typedRow("> sea\r\n\u001b[38;2;167;152;215m→ Auto-compact\u001b[0m")).toBeFalse();
    // a typed draft of both, a quote and an arrow, in the terminal's own colour, is one (#3769)
    expect(typedRow("> quoted\r\n→ an arrow line")).toBeTrue();
  });

  test("a read whose escapes carry no colour or style (bold, resets) proves nothing", () => {
    const colourless = readFileSync(join(FIXTURES, "pi/draft-typed-119.ansi"), "utf8").replace(/\u001b\[(?:[0-9;:]*)m/g, "\u001b[0m\u001b[1m");
    expect(drawsColour(colourless)).toBeFalse();
    expect(drawsColour(readFileSync(join(FIXTURES, "pi/draft-typed-119.ansi"), "utf8"))).toBeTrue();
  });

  test("loads and reads a screen where the runtime has no Intl.Segmenter (Safari 14, Firefox before 125)", async () => {
    const script = `delete Intl.Segmenter;
      const row = await import(${JSON.stringify(join(import.meta.dir, "inputRow.ts"))});
      const shared = await import(${JSON.stringify(join(import.meta.dir, "../../shared/input-row.ts"))});
      console.log(typeof row.FrameGate, shared.screenFromAnsi("\\u276f typed").rows[0].text);`;
    const child = Bun.spawn([process.execPath, "-e", script], { env: process.env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const [out, err] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(await child.exited, err).toBe(0);
    expect(out.trim()).toBe("function \u276f typed");
  });

  test.each([
    // `/mo` typed with the command list open: read with the list inside the box (muse), the box still whole (gjc, qwen,
    // cline), or the box out of its place (dsh-tui)
    ["gjc", true], ["muse", true], ["qwen", true], ["cline", true], ["dsh-tui", false],
  ])("%s, recorded in the agent lab: typed text is a draft, its empty box and placeholder are not", (agent, slash) => {
    expect(typed(agent, `${agent}/draft-typed-119.ansi`)).toBeTrue();
    expect(typed(agent, `${agent}/draft-empty-119.ansi`)).toBeFalse();
    expect(typed(agent, `${agent}/draft-slash-119.ansi`)).toBe(slash);
  });

  test("a Qwen draft whose second row starts with Qwen's own mark is still its box's draft (#3769)", () => {
    const rows = readFileSync(join(FIXTURES, "qwen/draft-typed-119.ansi"), "utf8").split("\n");
    const at = rows.findIndex((row) => row.includes("leftover draft"));
    rows.splice(at + 1, 0, "> quoted line\r");
    expect(typedDraft("qwen", screenFromAnsi(rows.join("\n")))).toBeTrue();
  });

  test("a GJC draft wrapped onto a second row of its box is read whole by the draft check", () => {
    const rows = readFileSync(join(FIXTURES, "gjc/draft-typed-119.ansi"), "utf8").split("\n");
    const at = rows.findIndex((row) => row.includes("\u2502 \u001b") && row.includes(">"));
    rows.splice(at + 1, 0, `\u2502   typed on the second row${" ".repeat(90)}\u2502\r`);
    expect(typedDraft("gjc", screenFromAnsi(rows.join("\n")))).toBeTrue();
  });

  test("a GJC draft that starts with a blank line is read from its wrapped rows", () => {
    const rows = readFileSync(join(FIXTURES, "gjc/draft-typed-119.ansi"), "utf8").replace("leftover draft", "").split("\n");
    const at = rows.findIndex((row) => row.includes("\u2502 \u001b") && row.includes(">"));
    rows.splice(at + 1, 0, `\u2502   typed on the second row${" ".repeat(90)}\u2502\r`);
    expect(typedDraft("gjc", screenFromAnsi(rows.join("\n")))).toBeTrue();
  });

  test("a draft wrapped onto a second row of the box is read whole", () => {
    const rows = readFileSync(join(FIXTURES, "muse/draft-typed-119.ansi"), "utf8").replace("leftover draft", "").split("\n");
    const at = rows.findIndex((row) => row.includes("\u276f"));
    rows.splice(at + 1, 0, "\u001b[38;2;204;211;219mtyped on the second row\u001b[0m\r");
    expect(typedDraft("muse", screenFromAnsi(rows.join("\n")))).toBeTrue();
  });

  test.each([
    // `/mo` typed: in the terminal's colour or the recorded typed colour (letta, maki, kilo), or drawn as a command (kimi, gemini)
    ["letta", true], ["maki", true], ["kimi", false], ["gemini", false], ["kilo", true],
  ])("%s, recorded in the agent lab: typed text is a draft, its empty box and placeholder are not", (agent, slash) => {
    expect(typed(agent, `${agent}/draft-typed-119.ansi`)).toBeTrue();
    expect(typed(agent, `${agent}/draft-empty-119.ansi`)).toBeFalse();
    expect(typed(agent, `${agent}/draft-slash-119.ansi`)).toBe(slash);
  });

  test("omp 18.14's editor under its unframed status line: typed text, on one row or more, and `/mo` are a draft; its hint is not", () => {
    expect(typed("omp", "omp/draft-typed-119.ansi")).toBeTrue();
    expect(typed("omp", "omp/draft-lines-119.ansi")).toBeTrue();
    expect(typed("omp", "omp/draft-slash-119.ansi")).toBeTrue();
    expect(typed("omp", "omp/draft-empty-119.ansi")).toBeFalse();
    // 18.8.7's framed editor reports no cells: never refused
    expect(typed("omp", "omp/settings-idle-119.ansi")).toBeFalse();
    // typed text in a colour the default theme does not give it (a theme not recorded) is no evidence
    const themed = readFileSync(join(FIXTURES, "omp/draft-typed-119.ansi"), "utf8").replace("\u001b[38;5;254mleftover", "\u001b[38;5;250mleftover");
    expect(typedDraft("omp", screenFromAnsi(themed))).toBeFalse();
  });

  test("omp 18.14's draft is read past an empty first row, an indented row and an empty row between, and as typed when it is the hint's words", () => {
    const lines = readFileSync(join(FIXTURES, "omp/draft-lines-119.ansi"), "utf8");
    // an empty first row, then a row indented past the editor's own three columns
    expect(typedDraft("omp", screenFromAnsi(lines.replace("leftover draft", "").replace("second line", "    indented")))).toBeTrue();
    // an empty row between two of the draft's rows
    const rows = lines.replace("leftover draft", "").split("\n");
    rows.splice(rows.findIndex((row) => row.includes("second line")), 0, "\r");
    expect(typedDraft("omp", screenFromAnsi(rows.join("\n")))).toBeTrue();
    // the hint's own words, typed in the typed colour
    expect(typedDraft("omp", screenFromAnsi(readFileSync(join(FIXTURES, "omp/draft-typed-119.ansi"), "utf8").replace("leftover draft", "⇧⇥ to change thinking effort")))).toBeTrue();
  });

  test("Kilo's box in a session, under its first answer, reads as on its home screen", () => {
    expect(typed("kilo", "kilo/draft-session-typed-119.ansi")).toBeTrue();
    expect(typed("kilo", "kilo/draft-session-empty-119.ansi")).toBeFalse();
    expect(typed("kilo", "kilo/draft-session-slash-119.ansi")).toBeTrue();
  });

  test("a character that draws nothing (Letta pads its empty box with zero-width spaces) is no typed text", () => {
    const rule = "\u2500".repeat(60);
    expect(typedDraft("letta", screenFromAnsi([rule, "\u203a \u001b[7m \u001b[0m\u200b\u200b\u200b", rule].join("\n")))).toBeFalse();
    expect(typedDraft("letta", screenFromAnsi([rule, "\u203a typed", rule].join("\n")))).toBeTrue();
  });

  test("an agent that draws typed text in a colour of its own: only that colour, as recorded, is typed", () => {
    const muse = readFileSync(join(FIXTURES, "muse/draft-typed-119.ansi"), "utf8");
    expect(typedDraft("muse", screenFromAnsi(muse))).toBeTrue();
    // the same words in another theme's colour are no evidence
    expect(typedDraft("muse", screenFromAnsi(muse.replaceAll("38;2;204;211;219m", "38;2;120;120;120m")))).toBeFalse();
    const cline = readFileSync(join(FIXTURES, "cline/draft-empty-119.ansi"), "utf8");
    // cline's grey placeholder
    expect(typedDraft("cline", screenFromAnsi(cline))).toBeFalse();
  });

  test("only typed-looking cells count: the same words dim, grey or italic are no draft", () => {
    const omo = readFileSync(join(FIXTURES, "omo/draft-typed-119.ansi"), "utf8");
    const styled = (sgr: string) => typedDraft("omo", screenFromAnsi(omo.replace(" leftover draft", ` \u001b[${sgr}mleftover draft\u001b[0m`)));
    expect(styled("0")).toBeTrue();
    expect(styled("2")).toBeFalse();
    expect(styled("3")).toBeFalse();
    expect(styled("38;5;244")).toBeFalse();
    expect(styled("38:2::90:90:90")).toBeFalse();
    // a recognizer that reports no cells (Claude and Hermes keep their own checks) never refuses
    expect(typedDraft("claude", screenFromAnsi(["\u2500".repeat(40), "\u276f still typing", "\u2500".repeat(40)].join("\n")))).toBeFalse();
    expect(typedDraft("letta", screenFromAnsi(omo))).toBeFalse();
    // a Codex `›` row with no model line under it is one of the history's messages, not the composer
    expect(typedDraft("codex", screenFromAnsi("› an earlier message"))).toBeFalse();
    expect(typedDraft("codex", screenFromAnsi("› typed\n\n  GPT-6.1-Sol default · ~/work"))).toBeTrue();
    // Codex's placeholder drawn undimmed (NO_COLOR) keeps its `? for shortcuts` hint, which typed text takes away
    expect(typedDraft("codex", screenFromAnsi("› Ask Codex to do anything\n\n  GPT-6.1-Sol default · ~/work\n  ← for agents · ? for shortcuts"))).toBeFalse();
  });
});
