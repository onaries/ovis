import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InteractivePrompt } from "../shared/protocol.ts";
import { handlePromptRequest, parseFallbackPrompt } from "./prompt.ts";

/** A herdr holding one pane whose screen the test sets; every key the answer route sends is kept. */
interface Pane { agent: string; screen: string; sent: string[] }

async function withPane(agent: string, status: string, screen: string, run: (pane: Pane) => Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "herdr-fallback-answer-"));
  const path = join(root, "herdr.sock");
  const pane: Pane = { agent, screen, sent: [] };
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => undefined);
    let input = "";
    socket.on("data", (chunk) => {
      input += chunk.toString();
      if (!input.includes("\n")) return;
      const request = JSON.parse(input.split("\n")[0]!) as { id: string; method: string; params: { keys?: string[]; text?: string } };
      const answer = (result: unknown) => socket.end(`${JSON.stringify({ id: request.id, result })}\n`);
      if (request.method === "session.snapshot") return answer({ snapshot: { panes: [{ pane_id: "p_1", agent: pane.agent, agent_status: status }], layouts: [] } });
      if (request.method === "pane.read") return answer({ read: { text: pane.screen } });
      if (request.method === "pane.process_info") return answer({ process_info: { foreground_processes: [] } });
      if (request.method === "pane.get") return answer({ pane: { pane_id: "p_1" } });
      if (request.method === "agent.get") return answer({ agent: {} });
      if (request.method !== "pane.send_keys" && request.method !== "pane.send_text") throw new Error(`unexpected fixture RPC: ${request.method}`);
      pane.sent.push(...(request.params.keys ?? [`text:${request.params.text}`]));
      answer({});
    });
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(path, resolve); });
  const previous = process.env["HERDR_SOCKET"];
  process.env["HERDR_SOCKET"] = path;
  try { await run(pane); } finally {
    if (previous === undefined) delete process.env["HERDR_SOCKET"];
    else process.env["HERDR_SOCKET"] = previous;
    for (const socket of sockets) socket.destroy();
    server.close();
    rmSync(root, { recursive: true, force: true });
  }
}

async function card(): Promise<InteractivePrompt | null> {
  const url = new URL("http://127.0.0.1/api/pane/prompt?pane_id=p_1");
  return ((await (await handlePromptRequest(new Request(url), url, {}))!.json()) as { prompt: InteractivePrompt | null }).prompt;
}

async function answer(promptId: string, choice: { option_index: number }): Promise<{ status: number; code?: string }> {
  const url = new URL("http://127.0.0.1/api/pane/prompt/answer");
  const response = (await handlePromptRequest(new Request(url, { method: "POST", body: JSON.stringify({ pane_id: "p_1", prompt_id: promptId, ...choice }) }), url, {}))!;
  const body = await response.json() as { error?: { code: string } };
  return { status: response.status, code: body.error?.code };
}

const labels = (prompt: InteractivePrompt) => prompt.options.map((option) => option.label);

// Agents with no reader of their own get the fallback card, and its answer was always refused: the read before the
// key had no screen to compare (readKnownPrompt reads none for them), and what they redraw while the prompt waits
// (Copilot's logo and timer, Grok's status line) changed the id every second. Recorded on Copilot 1.0.109, Grok
// 1.0.77 and Antigravity 1.5.6.
const recorded = (name: string): string => readFileSync(new URL(`./fixtures/${name}.txt`, import.meta.url), "utf8");

test.each([
  ["copilot", "copilot-1.0.109-trust-logo-a", "Do you trust the files in this folder?"],
  ["copilot", "copilot-1.0.109-ask-32s", "Which color?"],
  ["grok", "grok-1.0.77-ask", "┃  Option A or option B?"],
  ["agy", "agy-1.5.6-trust", "Do you trust the contents of this project?"],
  ["agy", "agy-1.5.6-ask", "Question 1/1: Which file would you like to create?"],
])("answers %s's fallback card on a screen that stands still (%s)", async (agent, name, question) => {
  await withPane(agent, "blocked", recorded(name), async (pane) => {
    const prompt = (await card())!;
    expect(prompt.fallback).toBe(true);
    expect(prompt.question).toBe(question);
    expect(await answer(prompt.id, { option_index: labels(prompt).indexOf("Enter") })).toEqual({ status: 200, code: undefined });
    expect(pane.sent).toEqual(["enter"]);
  });
});

test.each([
  ["Copilot's waiting timer", "copilot", recorded("copilot-1.0.109-ask-32s"), recorded("copilot-1.0.109-ask-36s")],
  ["Copilot's animated logo", "copilot", recorded("copilot-1.0.109-trust-logo-a"), recorded("copilot-1.0.109-trust-logo-b")],
  ["Grok's status line", "grok", recorded("grok-1.0.77-ask"), recorded("grok-1.0.77-ask").replace("7.4s ⇣21.5k [stop]", "9.1s ⇣22.0k [stop]")],
])("keeps the card and takes its answer while %s redraws", async (_what, agent, before, after) => {
  expect(after).not.toBe(before);
  await withPane(agent, "blocked", before, async (pane) => {
    const prompt = (await card())!;
    pane.screen = after;
    expect((await card())!.id).toBe(prompt.id);
    expect(await answer(prompt.id, { option_index: labels(prompt).indexOf("Enter") })).toEqual({ status: 200, code: undefined });
    expect(pane.sent).toEqual(["enter"]);
  });
});

test.each([
  ["the question", "Which color?", "Which size?"],
  ["an option", "   blue", "   green"],
  ["a number that is no time", "Copilot v1.0.109", "Copilot v1.0.110"],
  ["the words of its waiting row", "○ Asking user Waiting for response", "○ Running shell Waiting for response"],
])("still refuses a Copilot answer when %s changed under the card", async (_what, from, to) => {
  const screen = recorded("copilot-1.0.109-ask-32s");
  expect(screen).toContain(from);
  await withPane("copilot", "blocked", screen, async (pane) => {
    const prompt = (await card())!;
    pane.screen = recorded("copilot-1.0.109-ask-36s").replace(from, to);
    expect(await answer(prompt.id, { option_index: labels(prompt).indexOf("Enter") })).toEqual({ status: 409, code: "prompt_changed" });
    expect(pane.sent).toEqual([]);
  });
});

test("reads drawing glyphs outside Copilot's banner logo as written", () => {
  const screen = recorded("copilot-1.0.109-ask-32s");
  const id = (option: string) => parseFallbackPrompt("copilot", screen.replace("   blue", `   ${option}`)).id;
  expect(id("./\u2588.txt")).not.toBe(id("./\u2591.txt"));
  expect(id("blue \u2588")).not.toBe(id("blue \u2591"));
});

// a menu that marks its selection with a filled block against a hollow one: the mark moving is another card, so an
// Enter read for one row never lands on the other (merge-pass review of #3730)
test.each([["\u2591", "\u2588"], ["\u2591\u2591", "\u2588\u2588"], ["\u28c0", "\u28ff"]])("still refuses an answer once a menu marked %s / %s moved its selection", async (hollow, filled) => {
  const menu = (marks: [string, string]) => `Remove the staging database?\n\n${marks[0]} Delete\n${marks[1]} Keep\n\n↑/↓ to move · enter to choose\n`;
  await withPane("copilot", "blocked", menu([hollow, filled]), async (pane) => {
    const prompt = (await card())!;
    pane.screen = menu([filled, hollow]);
    expect(parseFallbackPrompt("copilot", pane.screen).id).not.toBe(prompt.id);
    expect(await answer(prompt.id, { option_index: labels(prompt).indexOf("Enter") })).toEqual({ status: 409, code: "prompt_changed" });
    expect(pane.sent).toEqual([]);
  });
});

// selection marks beside a border or guide glyph, at a row's end, or two glyphs wide (merge-pass review of #3730): the
// mark moving is another card for any agent, so an Enter read for one row never lands on the other
const SWAPPED_MARKS: [string, [string, string], [string, string]][] = [
  ["a heavy rule", ["\u2503 \u2588 Delete", "\u2503 \u2591 Keep"], ["\u2503 \u2591 Delete", "\u2503 \u2588 Keep"]],
  ["a double frame", ["\u2551 \u2588 Delete \u2551", "\u2551 \u2591 Keep \u2551"], ["\u2551 \u2591 Delete \u2551", "\u2551 \u2588 Keep \u2551"]],
  ["a tree guide", ["\u251c \u2588 Delete", "\u2514 \u2591 Keep"], ["\u251c \u2591 Delete", "\u2514 \u2588 Keep"]],
  ["the row's end", ["Delete \u2588", "Keep \u2591"], ["Delete \u2591", "Keep \u2588"]],
  ["two glyphs", ["\u2588\u2588 Delete", "\u2591\u2591 Keep"], ["\u2591\u2591 Delete", "\u2588\u2588 Keep"]],
  ["a column rule", ["\u2588 \u2502 Delete", "\u2591 \u2502 Keep"], ["\u2591 \u2502 Delete", "\u2588 \u2502 Keep"]],
];
test.each(SWAPPED_MARKS.flatMap(([shape, before, after]) => ["copilot", "claude"].map((agent) => [agent, shape, before, after] as const)))(
  "still refuses %s's answer once a selection marked beside %s moved", async (agent, _shape, before, after) => {
    const menu = (rows: readonly [string, string]) => `Remove the staging database?\n\n${rows[0]}\n${rows[1]}\n\n\u2191/\u2193 to move \u00b7 enter to choose\n`;
    await withPane(agent, "blocked", menu(before), async (pane) => {
      const prompt = (await card())!;
      pane.screen = menu(after);
      expect(await answer(prompt.id, { option_index: labels(prompt).indexOf("Enter") })).toEqual({ status: 409, code: "prompt_changed" });
      expect(pane.sent).toEqual([]);
    });
  });
