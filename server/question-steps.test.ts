import { describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InteractivePrompt, PromptAnswer } from "../shared/protocol.ts";
import { handlePromptRequest, KeyRefused, parseInteractivePrompt, type PromptRequestOptions } from "./prompt.ts";

/** A deadline a move that cannot finish reaches at once, so no test waits out the real 4 s */
const SHORT: PromptRequestOptions = { answerDeadlineMs: 300 };
import { omoAskOf } from "./omo-questions.ts";
import { type OmoAsk, parsedByPublicPrompt } from "./dialogs/shared.ts";

// The card moves between a form's questions without answering, as the agent's own keys do: OmO's
// Tab and Shift+Tab, Codex's ←/→, Hermes's Tab and Shift+Tab. Each key is sent alone and the
// screen must show the question it moves to before the next one.

const fixture = (name: string): string => readFileSync(join(import.meta.dir, "fixtures", `question-steps-${name}`), "utf8");
// omo 5.1.51 and Codex 0.166 as captured in a 120x40 herdr pane (fixtures/question-steps-captures.md)
const OMO_SCREENS = ["q1", "q2", "q3", "review"].map((state) => fixture(`omo-5.1.51-${state}.txt`));
/** omo's form of three questions: `at` 3 is its Submit tab. */
const omo = (at: number): string => OMO_SCREENS[at]!;
const OMO_TYPING = fixture("omo-5.1.51-q1-typing.txt");
/** the session's record of the ask_user_question call behind those screens */
const OMO_SESSION_CALL = fixture("omo-5.1.51.jsonl").split("\n")[0]!;
const CODEX_SCREENS = ["q1", "q2"].map((state) => fixture(`codex-0.166.0-${state}.txt`));
/** Codex's request_user_input with two questions. */
const codex = (at: number): string => CODEX_SCREENS[at]!;

const HERMES_HINT = "answered · ↑/↓ select · Enter confirm and continue · Tab/Shift+Tab switch question · Esc/Ctrl+C cancel";
const HERMES: readonly (readonly [string, readonly string[]])[] = [["Pick a colour", ["Red", "Blue"]], ["Pick a size", ["Small", "Large"]], ["Pick a shape", ["Circle", "Square"]]];
const HERMES_OPEN: readonly (readonly [string, readonly string[]])[] = [["Pick a colour", ["Red", "Blue"]], ["Name a fruit", []], ["Pick a shape", ["Circle", "Square"]]];

/** Hermes's clarify batch (ui-tui prompts.tsx): `✓` answered, `▸` the open one expanded, `·` waiting. */
function hermes(at: number, answered: number[] = [], questions = HERMES, typing = false): string {
  const lines = questions.flatMap(([question, choices], index) => [
    ` ${answered.includes(index) ? "✓" : index === at ? "▸" : "·"} ${question}`,
    ...(answered.includes(index) ? [`   ${choices[0] ?? "Apple"}`] : []),
    ...(index !== at ? [] : choices.length === 0 || typing ? ["   > "] : [...choices, "Other (type your answer)"].map((choice, row) => `   ${row === 0 ? "▸" : " "} ${row + 1}. ${choice}`)),
  ]);
  const hint = typing ? "answered · Enter confirm and continue · Esc back" : HERMES_HINT;
  return `\n ask 3 questions\n${lines.join("\n")}\n ${answered.length}/3 ${hint}\n ─ (⌐■_■) deliberating…  · 10s │ opus 5.5\n`;
}

const navigable = (prompt: InteractivePrompt | null) => prompt?.steps?.map((step) => step.can_navigate === true);

/** The session's ask_user_question call behind omo(): the card moves only on a form it can name by its questions. */
const OMO_CALL: OmoAsk = omoAskOf({ id: "session.jsonl\0toolu_qs", wait: true, args: (JSON.parse(OMO_SESSION_CALL) as { message: { content: { arguments: unknown }[] } }).message.content[0]!.arguments })!;
const omoCard = (screen: string, ask: OmoAsk | null = OMO_CALL) => parseInteractivePrompt("pi", screen, ask, true, ask ? [ask] : []);

describe("OmO's form: the card goes to another question as Tab and Shift+Tab do", () => {
  test("every other question is a step to tap, with Back and Next", () => {
    const first = omoCard(omo(0));
    expect(first).toMatchObject({ agent: "omo", title: "Question 1 of 3", can_step_next: true });
    expect(first?.can_step_back ?? false).toBe(false);
    expect(navigable(first)).toEqual([false, true, true]);
    const second = omoCard(omo(1));
    expect(second).toMatchObject({ title: "Question 2 of 3", can_step_back: true, can_step_next: true });
    expect(navigable(second)).toEqual([true, false, true]);
    // Next on the last question goes on to the review, as Tab does
    expect(omoCard(omo(2))).toMatchObject({ can_step_back: true, can_step_next: true });
  });

  test("a form no session call names is shown with its steps, and offers no move", () => {
    const unnamed = omoCard(omo(0), null);
    expect(unnamed?.steps?.map((step) => step.label)).toEqual(["Color", "Size", "Shape"]);
    expect(navigable(unnamed)).toEqual([false, false, false]);
    expect(unnamed?.can_step_next ?? false).toBe(false);
    // another call whose questions differ is another form: its identity says so
    const other: OmoAsk = { ...OMO_CALL, questions: OMO_CALL.questions.map((question, at) => at === 2 ? { ...question, options: [{ label: "Circle", description: null }, { label: "Triangle", description: null }] } : question) };
    const ids = [omoCard(omo(1)), omoCard(omo(1), other)].map((prompt) => parsedByPublicPrompt.get(prompt!)?.nativeSteps?.identity);
    expect(ids[0]).toBeDefined();
    expect(ids[1]).toBeDefined();
    expect(ids[0]).not.toBe(ids[1]);
  });

  test("the review goes back to any question, and has no Next", () => {
    const review = omoCard(omo(3));
    expect(review).toMatchObject({ title: "Review your answers", can_step_back: true });
    expect(review?.can_step_next ?? false).toBe(false);
    expect(navigable(review)).toEqual([true, true, true]);
  });

  test("an answer typed in the terminal holds the form: Tab would save it, so no step is offered", () => {
    const typing = OMO_TYPING;
    const prompt = omoCard(typing);
    expect(prompt?.kind).toBe("menu");
    expect(navigable(prompt)).toEqual([false, false, false]);
    expect(prompt?.can_step_back ?? false).toBe(false);
    expect(prompt?.can_step_next ?? false).toBe(false);
  });
});

describe("Codex's questions: the card goes back and on as ←/→ do", () => {
  test("Back after the first question, Next before the last", () => {
    const first = parseInteractivePrompt("codex", codex(0));
    expect(first).toMatchObject({ title: "Question 1 of 2", can_step_next: true });
    expect(first?.can_step_back ?? false).toBe(false);
    const last = parseInteractivePrompt("codex", codex(1));
    expect(last).toMatchObject({ title: "Question 2 of 2", can_step_back: true });
    expect(last?.can_step_next ?? false).toBe(false);
  });

  test("a hint without ←/→ offers neither", () => {
    const prompt = parseInteractivePrompt("codex", codex(0).replace(" | ←/→ to navigate questions", ""));
    expect(prompt?.title).toBe("Question 1 of 2");
    expect(prompt?.can_step_back ?? false).toBe(false);
    expect(prompt?.can_step_next ?? false).toBe(false);
  });
});

describe("Hermes's clarify batch: the card goes to another open question as Tab and Shift+Tab do", () => {
  test("each question is a step; the open ones can be gone to", () => {
    const prompt = parseInteractivePrompt("hermes", hermes(0));
    expect(prompt?.question).toBe("Pick a colour");
    expect(prompt?.steps?.map((step) => [step.label, step.answered, step.current])).toEqual([["Pick a colour", false, true], ["Pick a size", false, false], ["Pick a shape", false, false]]);
    // one key at a time: Hermes draws no options for the questions past the next one, so nothing names them
    expect(navigable(prompt)).toEqual([false, true, false]);
    expect(prompt).toMatchObject({ can_step_next: true });
    expect(prompt?.can_step_back ?? false).toBe(false);
  });

  test("the batch is named by every question, which are answered and the answer drawn under each", () => {
    const identity = (screen: string) => parsedByPublicPrompt.get(parseInteractivePrompt("hermes", screen)!)?.nativeSteps?.identity;
    const open = identity(hermes(1));
    expect(open).toBeDefined();
    // the same three questions: the first answered, or answered otherwise, is another batch
    expect(identity(hermes(1, [0]))).not.toBe(open);
    expect(identity(hermes(1, [0]).replace("   Red\n", "   Blue\n"))).not.toBe(identity(hermes(1, [0])));
  });

  test("an answered question shows no open marker once Tab is on it: nothing past it is offered", () => {
    const prompt = parseInteractivePrompt("hermes", hermes(0, [1]));
    expect(prompt?.steps?.map((step) => step.answered)).toEqual([false, true, false]);
    expect(navigable(prompt)).toEqual([false, false, false]);
    expect(prompt?.can_step_next ?? false).toBe(false);
  });
});

describe("Hermes's open-ended question in a batch", () => {
  test("keeps the batch's steps, Back and Next, as Tab moves through it", () => {
    const prompt = parseInteractivePrompt("hermes", hermes(1, [], HERMES_OPEN));
    expect(prompt?.question).toBe("Name a fruit");
    expect(prompt?.custom_option_index).toBe(0);
    expect(prompt?.steps?.map((step) => [step.label, step.current])).toEqual([["Pick a colour", false], ["Name a fruit", true], ["Pick a shape", false]]);
    expect(prompt).toMatchObject({ can_step_back: true, can_step_next: true });
  });

  test("while an answer is typed, Tab does nothing in Hermes: no move is offered", () => {
    const prompt = parseInteractivePrompt("hermes", hermes(1, [], HERMES_OPEN, true));
    expect(prompt?.question).toBe("Name a fruit");
    expect(navigable(prompt)).toEqual([false, false, false]);
    expect(prompt?.can_step_back ?? false).toBe(false);
    expect(prompt?.can_step_next ?? false).toBe(false);
  });
});

interface Pane { agent: string; screen: string; sent: string[]; onSent?: (key: string) => void; onRpc?: (method: string) => number | void; cwd?: string; omo?: { pid: number; path: string } }

async function withPane(agent: string, screen: string, run: (pane: Pane) => Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "question-steps-"));
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
      // a herdr that holds its reply this long (ms)
      const stall = pane.onRpc?.(request.method);
      const answer = (result: unknown) => {
        const reply = () => socket.end(`${JSON.stringify({ id: request.id, result })}\n`);
        if (typeof stall === "number") setTimeout(reply, stall);
        else reply();
      };
      if (request.method === "session.snapshot") return answer({ snapshot: { panes: [{ pane_id: "p_1", agent: pane.agent, agent_status: "blocked", cwd: pane.cwd, ...(pane.omo ? { agent_session: { agent: "omo", kind: "path", value: pane.omo.path } } : {}) }], layouts: [] } });
      if (request.method === "pane.read") return answer({ read: { text: pane.screen } });
      if (request.method === "pane.process_info") return answer({ process_info: { foreground_processes: pane.omo ? [{ pid: pane.omo.pid, argv: ["omo"] }] : pane.agent === "codex" ? [{ pid: 2147483647, argv: ["/usr/bin/codex"] }] : [] } });
      if (request.method === "agent.get") return answer({ agent: {} });
      if (request.method !== "pane.send_keys" && request.method !== "pane.send_text") throw new Error(`unexpected fixture RPC: ${request.method}`);
      for (const sent of request.params.keys ?? [`text:${request.params.text}`]) {
        pane.sent.push(sent);
        pane.onSent?.(sent);
      }
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

/**
 * An omo pane whose session holds the call behind omo(): an inert child gives the pane a real process environment
 * (OMO_CODING_AGENT_DIR), read through /proc as for a live omo, so Linux only.
 */
async function withOmoPane(screen: string, run: (pane: Pane) => Promise<void>, record = OMO_SESSION_CALL): Promise<void> {
  await withPane("pi", screen, async (pane) => {
    const root = mkdtempSync(join(tmpdir(), "question-steps-omo-"));
    const agentDir = join(root, "agent");
    mkdirSync(join(agentDir, "sessions"), { recursive: true });
    pane.cwd = root;
    const path = join(agentDir, "sessions", "2026-11-01T00-00-00_qs-session.jsonl");
    writeFileSync(path, JSON.stringify({ type: "session", id: "qs-session", cwd: root, timestamp: new Date().toISOString() }) + "\n" + record + "\n");
    const child = Bun.spawn([process.execPath, "-e", "process.stdin.resume()"], { cwd: root, stdin: "pipe", stdout: "ignore", stderr: "ignore", env: { ...process.env, OMO_CODING_AGENT_DIR: agentDir } });
    pane.omo = { pid: child.pid, path };
    try { await run(pane); } finally {
      child.kill();
      await child.exited;
      rmSync(root, { recursive: true, force: true });
    }
  });
}

async function card(): Promise<InteractivePrompt> {
  const url = new URL("http://127.0.0.1/api/pane/prompt?pane_id=p_1");
  const prompt = ((await (await handlePromptRequest(new Request(url), url, {}))!.json()) as { prompt: InteractivePrompt | null }).prompt;
  expect(prompt).not.toBeNull();
  return prompt!;
}

async function move(promptId: string, action: Omit<PromptAnswer, "pane_id" | "prompt_id">, options: PromptRequestOptions = {}): Promise<{ status: number; code?: string }> {
  const url = new URL("http://127.0.0.1/api/pane/prompt/answer");
  const response = (await handlePromptRequest(new Request(url, { method: "POST", body: JSON.stringify({ pane_id: "p_1", prompt_id: promptId, ...action }) }), url, options))!;
  const body = await response.json() as { error?: { code: string } };
  return { status: response.status, code: body.error?.code };
}

/** A pane whose form moves as the agent's keys move it, wrapping as they do. */
function follows(pane: Pane, draw: (at: number) => string, count: number, next: string, previous: string, start = 0): void {
  let at = start;
  pane.onSent = (key) => {
    if (key === next) at = (at + 1) % count;
    if (key === previous) at = (at + count - 1) % count;
    pane.screen = draw(at);
  };
}

describe("the answer route moves between questions, one key at a time, each seen", () => {
  test.skipIf(process.platform !== "linux")("OmO: Next sends Tab, and the card that comes back is the next question, not answered", async () => {
    await withOmoPane(omo(0), async (pane) => {
      follows(pane, omo, 4, "tab", "shift+tab");
      const first = await card();
      expect(await move(first.id, { step_next: true, draft: { option_indices: [], custom_text: "" } })).toEqual({ status: 200, code: undefined });
      expect(pane.sent).toEqual(["tab"]);
      const second = await card();
      expect(second).toMatchObject({ title: "Question 2 of 3", question: "Which size do you prefer?" });
      expect(second.steps?.map((step) => step.answered)).toEqual([false, false, false]);
    });
  });

  test.skipIf(process.platform !== "linux")("OmO: a tapped step two questions on sends Tab twice; Back on the review sends Shift+Tab", async () => {
    await withOmoPane(omo(0), async (pane) => {
      follows(pane, omo, 4, "tab", "shift+tab");
      expect(await move((await card()).id, { step_index: 2 })).toEqual({ status: 200, code: undefined });
      expect(pane.sent).toEqual(["tab", "tab"]);
      expect((await card()).question).toBe("Which shape do you prefer?");
    });
    await withOmoPane(omo(3), async (pane) => {
      follows(pane, omo, 4, "tab", "shift+tab", 3);
      expect(await move((await card()).id, { step_back: true })).toEqual({ status: 200, code: undefined });
      expect(pane.sent).toEqual(["shift+tab"]);
      expect((await card()).question).toBe("Which shape do you prefer?");
    });
  });

  test.skipIf(process.platform !== "linux")("OmO: a card a poll reads during a step answers the next tap", async () => {
    await withOmoPane(omo(0), async (pane) => {
      let at = 0;
      let poll: Promise<InteractivePrompt> | undefined;
      pane.onSent = (key) => {
        if (key === "tab") at += 1;
        pane.screen = omo(at);
        // the card's own poll, read while the step is still under way
        poll ??= card();
      };
      expect(await move((await card()).id, { step_next: true })).toEqual({ status: 200, code: undefined });
      const polled = await poll!;
      expect(polled.question).toBe("Which size do you prefer?");
      // the next tap comes from the card that poll drew: the same asking, not a stale one
      expect(await move(polled.id, { step_next: true })).toEqual({ status: 200, code: undefined });
      expect(pane.sent).toEqual(["tab", "tab"]);
    });
  });

  test.skipIf(process.platform !== "linux")("OmO: a form that does not move stops after its first key", async () => {
    await withOmoPane(omo(0), async (pane) => {
      const first = await card();
      expect(await move(first.id, { step_index: 2 }, SHORT)).toEqual({ status: 409, code: "prompt_changed" });
      expect(pane.sent).toEqual(["tab"]);
      // the Tab went out: the same drawing is asked anew, and the card it left takes no further move
      expect((await card()).id).not.toBe(first.id);
      expect(await move(first.id, { step_index: 1 }, SHORT)).toEqual({ status: 409, code: "prompt_changed" });
      expect(pane.sent).toEqual(["tab"]);
    });
  });

  test.skipIf(process.platform !== "linux")("OmO: a move's keys pass the answer's own guard, which may refuse the next one", async () => {
    await withOmoPane(omo(0), async (pane) => {
      follows(pane, omo, 4, "tab", "shift+tab");
      // the look before each key (a pi-ask form, an omp behind its shell): the second one says no
      const looked: string[] = [];
      const beforeKey = async (paneId: string, agent: string): Promise<void> => {
        looked.push(`${paneId} ${agent}`);
        if (looked.length === 2) throw new KeyRefused();
      };
      expect(await move((await card()).id, { step_index: 2 }, { beforeKey })).toEqual({ status: 409, code: "prompt_changed" });
      expect(looked).toEqual(["p_1 pi", "p_1 pi"]);
      expect(pane.sent).toEqual(["tab"]);
    });
  });

  test.skipIf(process.platform !== "linux")("OmO: a new call asked under the move gets no second key, its tabs alike", async () => {
    // the same headers, its last question asked with other options and another call id: another form, though the tabs read alike
    const CALL_ID = (JSON.parse(OMO_SESSION_CALL) as { message: { content: { id: string }[] } }).message.content[0]!.id;
    const changed = OMO_SESSION_CALL.replace('"label":"Square"', '"label":"Triangle"').replace(CALL_ID, `${CALL_ID}_again`);
    expect(changed).not.toBe(OMO_SESSION_CALL);
    await withOmoPane(omo(0), async (pane) => {
      let at = 0;
      pane.onSent = (key) => {
        if (key === "tab") at += 1;
        pane.screen = omo(at);
        // omo settles the call and asks again, appending to its session as it always does
        if (at === 1) appendFileSync(pane.omo!.path, `${JSON.stringify({ type: "custom", customType: "ask-user:settlement", data: { requestId: CALL_ID } })}\n${changed}\n`);
      };
      expect(await move((await card()).id, { step_index: 2 })).toEqual({ status: 409, code: "prompt_changed" });
      expect(pane.sent).toEqual(["tab"]);
    });
    // and a screen that changed between the card and the move: no key at all
    await withOmoPane(omo(0), async (pane) => {
      const first = await card();
      pane.screen = omo(1);
      expect((await move(first.id, { step_index: 2 })).status).toBe(409);
      expect(pane.sent).toEqual([]);
    });
  });

  test.skipIf(process.platform !== "linux")("OmO: a guard that outlasts the request's deadline sends no further key", async () => {
    await withOmoPane(omo(0), async (pane) => {
      follows(pane, omo, 4, "tab", "shift+tab");
      // the second key's look never comes back (herdr holding its reply): the deadline ends it, 300 ms here, 4 s in the server
      let looks = 0;
      const beforeKey = (): Promise<void> => ++looks === 2 ? new Promise<void>(() => undefined) : Promise.resolve();
      expect(await move((await card()).id, { step_index: 2 }, { ...SHORT, beforeKey })).toEqual({ status: 409, code: "prompt_changed" });
      expect(pane.sent).toEqual(["tab"]);
    });
  });

  test.skipIf(process.platform !== "linux")("OmO: an answer with the move, a step out of reach or the card's unsent edits send nothing", async () => {
    await withOmoPane(omo(0), async (pane) => {
      const first = await card();
      const refused = { status: 400, code: "invalid_answer" };
      expect(await move(first.id, { step_next: true, option_index: 0 })).toEqual(refused);
      expect(await move(first.id, { step_back: true })).toEqual(refused);
      expect(await move(first.id, { step_next: true, step_back: true })).toEqual(refused);
      expect(await move(first.id, { step_index: 0 })).toEqual(refused);
      expect(await move(first.id, { step_next: true, draft: { option_indices: [], custom_text: "green" } })).toEqual(refused);
      expect(pane.sent).toEqual([]);
    });
  });

  test("Codex: Next sends → and Back sends ←, each seen on screen", async () => {
    await withPane("codex", codex(0), async (pane) => {
      let at = 0;
      pane.onSent = (key) => { at = key === "right" ? Math.min(1, at + 1) : key === "left" ? Math.max(0, at - 1) : at; pane.screen = codex(at); };
      expect(await move((await card()).id, { step_next: true })).toEqual({ status: 200, code: undefined });
      expect((await card()).question).toBe("Which size do you choose?");
      expect(await move((await card()).id, { step_back: true })).toEqual({ status: 200, code: undefined });
      expect(pane.sent).toEqual(["right", "left"]);
      expect((await card()).question).toBe("Which color do you choose?");
    });
  });

  test("Hermes: Next sends Tab, and the card comes back on the next open question", async () => {
    await withPane("hermes", hermes(0), async (pane) => {
      follows(pane, (at) => hermes(at), 3, "tab", "shift+tab");
      expect(await move((await card()).id, { step_next: true })).toEqual({ status: 200, code: undefined });
      expect(pane.sent).toEqual(["tab"]);
      expect((await card()).question).toBe("Pick a size");
    });
  });

  test("Hermes: Next onto an open-ended question lands there, its steps kept", async () => {
    await withPane("hermes", hermes(0, [], HERMES_OPEN), async (pane) => {
      follows(pane, (at) => hermes(at, [], HERMES_OPEN), 3, "tab", "shift+tab");
      expect(await move((await card()).id, { step_next: true })).toEqual({ status: 200, code: undefined });
      const open = await card();
      expect(open.question).toBe("Name a fruit");
      expect(open.steps?.findIndex((step) => step.current)).toBe(1);
    });
  });

  test("Hermes: another batch with the same questions drawn after a Tab gets no second one", async () => {
    // the same three questions, asked with other choices
    const OTHER: readonly (readonly [string, readonly string[]])[] = HERMES.map(([question], index) => [question, index === 1 ? ["Tiny", "Huge"] : ["Red", "Blue"]]);
    await withPane("hermes", hermes(0), async (pane) => {
      let at = 0;
      pane.onSent = (key) => {
        if (key === "tab") at += 1;
        pane.screen = hermes(at, [], OTHER);
      };
      expect((await move((await card()).id, { step_index: 2 })).status).toBe(400);
      expect(pane.sent).toEqual([]);
      // a single Next lands; the next move is asked against the card it shows
      expect(await move((await card()).id, { step_next: true })).toEqual({ status: 200, code: undefined });
      expect(pane.sent).toEqual(["tab"]);
      expect((await card()).options.map((option) => option.label)).toEqual(["Tiny", "Huge"]);
    });
  });

  test("an answer whose first read outlasts the deadline sends nothing", async () => {
    await withPane("hermes", hermes(0), async (pane) => {
      const first = await card();
      // herdr answers every read after the deadline
      pane.onRpc = (method) => method === "pane.read" ? 600 : undefined;
      expect(await move(first.id, { option_index: 1 }, SHORT)).toEqual({ status: 409, code: "prompt_changed" });
      expect(pane.sent).toEqual([]);
    });
  });

  test.skipIf(process.platform !== "linux")("OmO: a key whose reply never comes ends the move at the deadline", async () => {
    await withOmoPane(omo(0), async (pane) => {
      follows(pane, omo, 4, "tab", "shift+tab");
      const first = await card();
      // herdr writes the key and holds its reply past any test's budget
      pane.onRpc = (method) => method === "pane.send_keys" ? 60_000 : undefined;
      expect(await move(first.id, { step_index: 2 }, SHORT)).toEqual({ status: 409, code: "prompt_changed" });
      expect(pane.sent).toEqual(["tab"]);
    });
  });

  test("a card with no keys of its own to move by refuses Next", async () => {
    const one = `\n ask 1 question\n ▸ Pick a colour\n   ▸ 1. Red\n     2. Blue\n     3. Other (type your answer)\n 0/1 ${HERMES_HINT}\n`;
    await withPane("hermes", one, async (pane) => {
      // with an answer in the same body, too: Next is never read as that answer
      expect(await move((await card()).id, { step_next: true, option_index: 0 })).toEqual({ status: 400, code: "invalid_answer" });
      expect(await move((await card()).id, { step_next: true })).toEqual({ status: 400, code: "invalid_answer" });
      expect(pane.sent).toEqual([]);
    });
  });
});
