import { afterEach, beforeEach, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { paneCommands } from "./commands.ts";
import { HERMES_ECHO_RE } from "./dialogs/hermes.ts";
import { registry } from "./dialogs/registry.ts";
import { findLastIndex } from "./dialogs/shared.ts";
import { handlePaneRequest } from "./pane-routes.ts";
import { paneAgentOf, resolveAgent } from "./pane-context.ts";
import { openCodeServiceOptions } from "./opencode-service.ts";

// The real RPC client against a unix socket this test owns; only herdr's answers are synthetic.
let root: string;
let listener: ReturnType<typeof Bun.listen>;
let socketBefore: string | undefined;
let panes: Record<string, { agent?: string; session?: string; process: { pid: number; argv: string[]; cwd: string }[] }>;

const paneInfo = (id: string) => ({
  pane_id: id, workspace_id: "w", tab_id: "w:t1", terminal_id: id, cwd: root, focused: false, revision: 0,
  ...(panes[id]?.agent ? { agent: panes[id]!.agent } : {}),
  ...(panes[id]?.session ? { agent_session: { agent: "opencode", source: "herdr:opencode", kind: "id", value: panes[id]!.session } } : {}),
});

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ovis-pane-routes-"));
  panes = {};
  socketBefore = process.env["HERDR_SOCKET"];
  const socket = join(root, "herdr.sock");
  process.env["HERDR_SOCKET"] = socket;
  listener = Bun.listen<{ buffer: string }>({
    unix: socket,
    socket: {
      open(socket) { socket.data = { buffer: "" }; },
      data(socket, chunk) {
        socket.data.buffer += chunk.toString();
        if (!socket.data.buffer.includes("\n")) return;
        const request = JSON.parse(socket.data.buffer) as { id: string; method: string; params?: { pane_id?: string } };
        const id = request.params?.pane_id ?? "";
        const result = request.method === "pane.get" ? { pane: paneInfo(id) }
          : request.method === "pane.process_info" ? { process_info: { foreground_processes: panes[id]?.process ?? [] } }
          : request.method === "session.snapshot" ? { snapshot: { panes: Object.keys(panes).map(paneInfo), agents: [] } }
          : null;
        if (result === null) throw new Error(`unexpected RPC ${request.method}`);
        socket.end(`${JSON.stringify({ id: request.id, result })}\n`);
      },
    },
  });
});

afterEach(() => {
  listener.stop(true);
  if (socketBefore === undefined) delete process.env["HERDR_SOCKET"];
  else process.env["HERDR_SOCKET"] = socketBefore;
  rmSync(root, { recursive: true, force: true });
});

const OMO_PROCESS = { pid: 2147483647, argv: ["omo"], cwd: "" };

it("names an omo pane that herdr labels pi omo in the commands route, and types into it as omo only once omo holds a session", async () => {
  panes["w:p1"] = { agent: "pi", process: [{ ...OMO_PROCESS, cwd: root }] };
  panes["w:p2"] = { agent: "pi", process: [{ pid: 2147483646, argv: ["/usr/bin/pi"], cwd: root }] };
  // typing needs omo's own holder record (server/core/omo-pane-send.test.ts): an argv alone keeps herdr's label
  expect(await paneAgentOf("w:p1")).toBe("pi");
  // an ordinary pi stays pi
  expect(await paneAgentOf("w:p2")).toBe("pi");

  // omo's catalog describes /quit in its own words, pi's in others: the route answers with the pane's
  const quit = async (paneId: string) => {
    const url = new URL(`http://x/api/pane/commands?pane_id=${paneId}`);
    const response = await handlePaneRequest(new Request(url), url, "/api/pane/commands", {});
    return ((await response!.json()) as { commands: { name: string; description: string }[] }).commands.find((command) => command.name === "quit")?.description;
  };
  const omoQuit = paneCommands("omo", root).find((command) => command.name === "quit")?.description;
  const piQuit = paneCommands("pi", root).find((command) => command.name === "quit")?.description;
  expect(omoQuit).not.toBe(piQuit);
  expect(await quit("w:p1")).toBe(omoQuit);
  expect(await quit("w:p2")).toBe(piQuit);
});

/** a Hermes pane in the fake herdr, its skills under a HOME of the test's own */
async function hermesPane(paneId: string, run: (f: { skill(name: string): void; names(): Promise<string[]> }) => Promise<void>): Promise<void> {
  const homeBefore = process.env["HOME"];
  process.env["HOME"] = root;
  panes[paneId] = { agent: "hermes", process: [{ pid: 2147483645, argv: ["hermes"], cwd: root }] };
  try {
    await run({
      skill(name) {
        mkdirSync(join(root, ".hermes", "skills", name), { recursive: true });
        writeFileSync(join(root, ".hermes", "skills", name, "SKILL.md"), `---\nname: ${name}\ndescription: Added on disk.\n---\nBody.\n`);
      },
      async names() {
        const url = new URL(`http://x/api/pane/commands?pane_id=${paneId}`);
        const response = await handlePaneRequest(new Request(url), url, "/api/pane/commands", {});
        return ((await response!.json()) as { commands: { name: string }[] }).commands.map((command) => command.name);
      },
    });
  } finally {
    if (homeBefore === undefined) delete process.env["HOME"];
    else process.env["HOME"] = homeBefore;
  }
}

it("lists a Hermes skill added on disk before a successful reload on the next commands request", async () => {
  const screen = readFileSync(join(import.meta.dir, "fixtures", "hermes-results", "reload-skills-added-120.txt"), "utf8");
  const lines = screen.split("\n");
  const below = lines.slice(findLastIndex(lines, (line) => HERMES_ECHO_RE.exec(line.trimEnd())?.[1] === "/reload-skills") + 1).join("\n");
  const reload = registry.readersFor("hermes").find((reader) => reader.id === "hermes-reload-skills")!;
  await hermesPane("w:hermes", async ({ skill, names }) => {
    expect(await names()).not.toContain("fixture-added");
    skill("fixture-added");
    // the recognized reload the client refetches on (catalog_changed)
    expect(reload.parse(below, { agent: "hermes", omoAsk: null, omoTrusted: false, omoOpen: [], sent: "/reload-skills", working: false })?.catalogChanged).toBeTrue();
    expect(await names()).toContain("fixture-added");
  });
});

it("reflects a /reload-skills typed in Hermes's own terminal on the next commands request", async () => {
  await hermesPane("w:typed", async ({ skill, names }) => {
    expect(await names()).not.toContain("typed-reload-skill");
    skill("typed-reload-skill");
    expect(await names()).toContain("typed-reload-skill");
  });
});

it("lists an agent's commands for a folder with no pane, from the folder's skills and the static tables alone", async () => {
  const homeBefore = process.env["HOME"];
  // the user's own skills stay out of the answer: a HOME of the test's own
  process.env["HOME"] = join(root, "home");
  mkdirSync(join(root, "home"), { recursive: true });
  try {
    const project = join(root, "project");
    mkdirSync(join(project, ".codex", "skills", "fixture-skill"), { recursive: true });
    writeFileSync(join(project, ".codex", "skills", "fixture-skill", "SKILL.md"), "---\nname: fixture-skill\ndescription: A fixture skill.\n---\nBody.\n");
    const ask = async (query: string, method = "GET") => {
      const url = new URL(`http://x/api/agent/commands${query}`);
      return (await handlePaneRequest(new Request(url, { method }), url, "/api/agent/commands", {}))!;
    };
    // no herdr RPC answers this route: the fake socket above would throw for one
    const listed = await ask(`?agent=codex&cwd=${encodeURIComponent(project)}`);
    expect(listed.status).toBe(200);
    const { commands } = (await listed.json()) as { commands: { name: string; source: string; trigger?: string; origin?: string; provenance?: { transport: string; verified: boolean } }[] };
    expect(commands.filter((command) => command.source === "skill")).toMatchObject([{ name: "fixture-skill", source: "skill", trigger: "$", origin: "project", provenance: { transport: "scan", verified: false } }]);
    expect(commands.some((command) => command.source === "builtin")).toBeTrue();
    // no process, no version: no row is verified against one
    expect(commands.every((command) => command.provenance?.verified === false)).toBeTrue();
    // the folder is optional; an agent the bridge has no tables for has no rows
    expect(await (await ask("?agent=nonesuch")).json()).toEqual({ commands: [] });
    const missingAgent = await ask("");
    expect(missingAgent.status).toBe(400);
    expect(((await missingAgent.json()) as { error: { code: string } }).error.code).toBe("missing_agent");
    const missingFolder = await ask(`?agent=codex&cwd=${encodeURIComponent(join(root, "missing"))}`);
    expect(missingFolder.status).toBe(400);
    expect(((await missingFolder.json()) as { error: { code: string } }).error.code).toBe("invalid_cwd");
    expect((await ask("?agent=codex", "POST")).status).toBe(400);
  } finally {
    if (homeBefore === undefined) delete process.env["HOME"];
    else process.env["HOME"] = homeBefore;
  }
});

it("lists OpenCode's skills for a folder with no pane in the form its installed version types them", async () => {
  const homeBefore = process.env["HOME"];
  process.env["HOME"] = join(root, "home");
  mkdirSync(join(root, "home"), { recursive: true });
  try {
    const project = join(root, "project");
    mkdirSync(join(project, ".opencode", "skills", "effect"), { recursive: true });
    writeFileSync(join(project, ".opencode", "skills", "effect", "SKILL.md"), "---\nname: effect\ndescription: Apply Effect.\n---\nBody.\n");
    const state = join(root, "opencode-state");
    mkdirSync(state, { recursive: true });
    // the server's own OpenCode state (createServer's openCodeStateDir), not the process-wide default
    const skill = async () => {
      const url = new URL(`http://x/api/agent/commands?agent=opencode&cwd=${encodeURIComponent(project)}`);
      const { commands } = await (await handlePaneRequest(new Request(url), url, "/api/agent/commands", { openCodeStateDir: state }))!.json() as { commands: { name: string; source: string; trigger?: string }[] };
      return commands.find((command) => command.name === "effect");
    };
    openCodeServiceOptions.stateDir = join(root, "elsewhere");
    // no OpenCode 2 has written its service file: the v1 form
    const v1 = await skill();
    expect(v1?.source).toBe("skill");
    expect(v1?.trigger ?? "/").toBe("/");
    // OpenCode 2.0.32 names its version in service.json: its skills are typed with @
    writeFileSync(join(state, "service.json"), JSON.stringify({ url: "http://127.0.0.1:9", pid: process.pid, password: "fixture", version: "2.0.32" }));
    expect(await skill()).toMatchObject({ source: "skill", trigger: "@" });
  } finally {
    delete openCodeServiceOptions.stateDir;
    if (homeBefore === undefined) delete process.env["HOME"];
    else process.env["HOME"] = homeBefore;
  }
});

/** an OpenCode pane (herdr labels it opencode) in a project with one skill, under a HOME and state dir of the test's own */
async function openCodePane(run: (f: { state: string; skill(): Promise<{ trigger?: string; provenance?: { verified?: boolean } } | undefined> }) => Promise<void>, session?: string): Promise<void> {
  const homeBefore = process.env["HOME"];
  process.env["HOME"] = mkdtempSync(join(tmpdir(), "ovis-pane-routes-home-"));
  mkdirSync(join(root, ".opencode", "skills", "effect"), { recursive: true });
  writeFileSync(join(root, ".opencode", "skills", "effect", "SKILL.md"), "---\nname: effect\ndescription: Apply Effect.\n---\nBody.\n");
  const state = mkdtempSync(join(root, "opencode-state-"));
  panes["w:p1"] = { agent: "opencode", ...(session ? { session } : {}), process: [{ pid: 2147483644, argv: ["opencode"], cwd: root }] };
  openCodeServiceOptions.stateDir = join(root, "elsewhere");
  try {
    await run({
      state,
      async skill() {
        const url = new URL("http://x/api/pane/commands?pane_id=w:p1");
        const response = await handlePaneRequest(new Request(url), url, "/api/pane/commands", { openCodeStateDir: state, opencodeDb: join(root, "opencode.db") });
        const { commands } = await response!.json() as { commands: { name: string; trigger?: string; provenance?: { verified?: boolean } }[] };
        return commands.find((command) => command.name === "effect");
      },
    });
  } finally {
    delete openCodeServiceOptions.stateDir;
    rmSync(process.env["HOME"]!, { recursive: true, force: true });
    if (homeBefore === undefined) delete process.env["HOME"];
    else process.env["HOME"] = homeBefore;
  }
}

it("offers a session-less OpenCode pane's skill in the form its installed version types, unverified", async () => {
  await openCodePane(async ({ state, skill }) => {
    // no service file: the v1 form
    const v1 = await skill();
    expect(v1?.trigger ?? "/").toBe("/");
    // OpenCode 2.0.32 names its version in service.json: the skill is typed with @, but the file verifies nothing
    writeFileSync(join(state, "service.json"), JSON.stringify({ url: "http://127.0.0.1:9", pid: process.pid, password: "fixture", version: "2.0.32" }));
    const v2 = await skill();
    expect(v2?.trigger).toBe("@");
    expect(v2?.provenance?.verified).toBe(false);
  });
});

it("does not give a pane with an OpenCode session it cannot read the service file's version", async () => {
  // no opencode.db: the session's own version is unknown, and it may be an OpenCode 1 session
  await openCodePane(async ({ state, skill }) => {
    writeFileSync(join(state, "service.json"), JSON.stringify({ url: "http://127.0.0.1:9", pid: process.pid, password: "fixture", version: "2.0.32" }));
    expect((await skill())?.trigger ?? "/").toBe("/");
  }, "ses_paneRoutesUnread");
});

it("keeps the version a pane's own OpenCode session records over the service file's", async () => {
  const database = join(root, "opencode.db");
  const db = new Database(database, { create: true });
  db.exec("CREATE TABLE session_v2 (id text PRIMARY KEY, project_id text NOT NULL, slug text NOT NULL, directory text NOT NULL, title text, version text NOT NULL, revert text, time_created integer NOT NULL, time_updated integer NOT NULL)");
  db.exec("CREATE TABLE session_message (id text PRIMARY KEY, session_id text NOT NULL, type text NOT NULL, seq integer NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL)");
  db.query("INSERT INTO session_v2 (id, project_id, slug, directory, title, version, time_created, time_updated) VALUES ('ses_paneRoutes01', 'global', 's', ?, 't', '1.19.3', 0, 0)").run(root);
  db.close();
  await openCodePane(async ({ state, skill }) => {
    writeFileSync(join(state, "service.json"), JSON.stringify({ url: "http://127.0.0.1:9", pid: process.pid, password: "fixture", version: "2.0.32" }));
    // the store's 1.19.3 wins: the v1 form, not the service's @
    expect((await skill())?.trigger ?? "/").toBe("/");
  }, "ses_paneRoutes01");
});

it("answers OpenCode's commands for a folder with no pane while its opencode.json is a FIFO no one writes", async () => {
  const homeBefore = process.env["HOME"];
  process.env["HOME"] = join(root, "home");
  mkdirSync(join(root, "home"), { recursive: true });
  const project = join(root, "fifo-project");
  mkdirSync(project, { recursive: true });
  const fifo = join(project, "opencode.json");
  expect(await Bun.spawn(["mkfifo", fifo]).exited).toBe(0);
  // the writer comes long after the answer should: a read that blocks on the FIFO could only return once
  // the writer opened it, after it marks `opening`
  const opening = join(root, "fifo-opening");
  const writer = Bun.spawn(["sh", "-c", `sleep 20; touch '${opening}'; printf '{}' > '${fifo}'`]);
  try {
    const url = new URL(`http://x/api/agent/commands?agent=opencode&cwd=${encodeURIComponent(project)}`);
    const response = (await handlePaneRequest(new Request(url), url, "/api/agent/commands", { openCodeStateDir: join(root, "no-opencode-state") }))!;
    expect(existsSync(opening)).toBe(false);
    expect(response.status).toBe(200);
    expect(((await response.json()) as { commands: unknown[] }).commands.length).toBeGreaterThan(0);
  } finally {
    writer.kill();
    rmSync(fifo, { force: true });
    if (homeBefore === undefined) delete process.env["HOME"];
    else process.env["HOME"] = homeBefore;
  }
});

it("resolves a pane with no agent to null and its commands route to []", async () => {
  panes["w:p3"] = { process: [] };
  expect(await paneAgentOf("w:p3")).toBeNull();
  const url = new URL("http://x/api/pane/commands?pane_id=w:p3");
  const response = await handlePaneRequest(new Request(url), url, "/api/pane/commands", {});
  expect(await response!.json()).toEqual({ commands: [] });
});

const claudeLine = (version: string) => JSON.stringify({ type: "user", version, message: { role: "user", content: "hi" } }) + "\n";

it("reads a version from the store the pane's own transcript names, and leaks none to another pane", () => {
  const first = join(root, "first.jsonl");
  const second = join(root, "second.jsonl");
  writeFileSync(first, claudeLine("2.1.100"));
  writeFileSync(second, claudeLine("2.1.200"));
  const pane = (agent: string) => ({ agent }) as never;
  expect(resolveAgent(pane("claude"), null, { path: first })).toEqual({ agent: "claude", version: "2.1.100" });
  expect(resolveAgent(pane("claude"), null, { path: second })).toEqual({ agent: "claude", version: "2.1.200" });
  expect(resolveAgent(pane("claude"), null, { path: first }).version).toBe("2.1.100");
  // no store, an agent that keeps no version, an omo pane: unverified
  expect(resolveAgent(pane("claude"), null).version).toBeNull();
  expect(resolveAgent(pane("pi"), null, { path: first }).version).toBeNull();
  expect(resolveAgent(pane("claude"), { omo: { agentDir: null, pluginDir: null } }, { path: first })).toEqual({ agent: "omo", version: null });
  // a session report names the agent when herdr's label is absent
  expect(resolveAgent({ agent_session: { agent: "codex" } } as never, null).agent).toBe("codex");
  expect(resolveAgent({} as never, null)).toEqual({ agent: null, version: null });
});
