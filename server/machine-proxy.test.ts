import { afterAll, describe, expect, it } from "bun:test";

import { agentRowTokens } from "./herdr-sidebar.ts";
import { handleMachineRequest } from "./machine-api.ts";
import type { MachineManager } from "./machines.ts";

// A remote bridge that answers like the local conversation route: an ETag, then 304 while unchanged.
const asked: (string | null)[] = [];
const promptAsked: (string | null)[] = [];
const PLAN_CARD = { id: "claude-plan:abc", agent: "claude", kind: "plan", title: "Plan", question: "Would you like to proceed?", options: [{ label: "Yes", description: null }], multi_select: false, custom_option_index: null };
const historyAsked: (string | null)[] = [];
const commandsAsked: string[] = [];
const filesAsked: string[] = [];
const worktreesAsked: string[] = [];
const faviconAsked: { search: string; authorization: string | null; cookie: string | null }[] = [];
const diffAsked: { path: string; search: string; authorization: string | null; cookie: string | null; forwarded: string | null }[] = [];
const remote = Bun.serve({
  port: 0,
  fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/api/pane/conversation/image") return new Response(new Uint8Array([137, 80, 78, 71]), { headers: { "content-type": "image/png" } });
    if (path === "/api/pane/conversation/tool-output") return new Response("complete remote output", { headers: { "content-type": "text/plain; charset=utf-8" } });
    if (path === "/api/fs/file") return new Response("%PDF-1.7", { headers: { "content-type": "application/pdf" } });
    if (path === "/api/session") return Response.json({ snapshot: { workspaces: [], tabs: [], panes: [{ pane_id: "w1:p1", workspace_id: "w1", tab_id: "t1", agent: "claude", tokens: { quota: "off · private", eta: "soon" } }], agents: [] } });
    if (path === "/api/sessions/history") {
      historyAsked.push(request.headers.get("authorization"));
      return Response.json({ workspace_id: "w1", agent: "pi", cwd: "/work", sessions: [{ id: "s1", title: null, firstMessage: "a private prompt", startedAt: null, updatedAt: "2026-10-01T00:00:00.000Z", resume: null }] });
    }
    if (path === "/api/pane/commands" || path === "/api/agent/commands") {
      commandsAsked.push(path);
      // a PC whose skill folders are too slow to scan in time (#2254)
      if (new URL(request.url).searchParams.get("pane_id") === "busy") return Response.json({ error: { code: "file_busy", message: "the skill folders did not answer in time" } }, { status: 503, headers: { "retry-after": "1" } });
      return Response.json({ commands: [{ name: "deploy", description: "SECRET", source: "custom", id: "/work/.commandcode/commands/deploy.md" }] });
    }
    if (path === "/api/pane/files" || path === "/api/plugin/action") {
      filesAsked.push(path);
      return Response.json(path === "/api/pane/files" ? { files: [".env.SECRET"] } : { log_id: "plugin-log-1", status: "failed", exit_code: 1, output: "SECRET", opened_pane_id: null });
    }
    if (path === "/api/worktree/list") {
      worktreesAsked.push(path);
      return Response.json({ source: { repo_key: "repo" }, worktrees: [{ path: "/work-wt/SECRET", branch: "SECRET", open_workspace_id: null }] });
    }
    if (path === "/api/fs/favicon") {
      faviconAsked.push({ search: new URL(request.url).search, authorization: request.headers.get("authorization"), cookie: request.headers.get("cookie") });
      return Response.json({ icon: null });
    }
    if (path === "/api/pane/prompt") {
      const search = new URL(request.url).searchParams;
      promptAsked.push(search.get("plan"));
      // pane `old` is a PC that does not know `plan=0` and always answers with the plan file
      const screen = search.get("plan") === "0" && search.get("pane_id") !== "old";
      return Response.json({ prompt: screen
        ? { ...PLAN_CARD, body: "4. The last step that fits the pane." }
        : { ...PLAN_CARD, id: `${PLAN_CARD.id}.0123abcd`, body: "1. A secret step from the plan file.", plan_file: "/home/u/.claude/plans/p.md" }, suggestion: null, restored: null });
    }
    if (path.startsWith("/api/workspace/diff/")) {
      diffAsked.push({ path, search: new URL(request.url).search, authorization: request.headers.get("authorization"), cookie: request.headers.get("cookie"), forwarded: request.headers.get("x-forwarded-for") });
      return Response.json({ files: [], total: 0, truncated: false }, { headers: { "set-cookie": "remote=1" } });
    }
    const ifNoneMatch = request.headers.get("if-none-match");
    asked.push(ifNoneMatch);
    if (ifNoneMatch === "\"v1\"") return new Response(null, { status: 304, headers: { etag: "\"v1\"" } });
    return Response.json({ source: "claude-transcript", turns: [] }, { headers: { etag: "\"v1\"" } });
  },
});
afterAll(() => remote.stop());

const manager = {
  endpoint: () => ({ url: `http://127.0.0.1:${remote.port}`, token: "remote-token" }),
  trackTerminal: () => () => undefined,
} as unknown as MachineManager;

describe("PC proxy", () => {
  it("carries a conversation's ETag both ways and passes an unchanged answer on as a bodyless 304", async () => {
    const url = "http://127.0.0.1/api/machines/pc1/pane/conversation?pane_id=w1%3Ap1";
    const first = await handleMachineRequest(new Request(url), manager);
    expect(first.status).toBe(200);
    expect(first.headers.get("etag")).toBe("\"v1\"");
    await first.json();
    const unchanged = await handleMachineRequest(new Request(url, { headers: { "if-none-match": "\"v1\"" } }), manager);
    expect(unchanged.status).toBe(304);
    expect(unchanged.headers.get("etag")).toBe("\"v1\"");
    expect(await unchanged.text()).toBe("");
    expect(asked).toEqual([null, "\"v1\""]);
  });
});

it("never forwards a PC's session history to a watching device, nor a route spelled with a trailing, doubled or encoded slash", async () => {
  const base = "http://127.0.0.1/api/machines/pc1";
  const query = "?workspace_id=w1&agent=pi";
  const watched = await handleMachineRequest(new Request(`${base}/sessions/history${query}`), manager, undefined, undefined, true);
  expect(watched.status).toBe(403);
  expect(await watched.text()).not.toContain("a private prompt");
  for (const readOnly of [true, false]) {
    for (const path of ["sessions/history/", "sessions//history", "sessions%2Fhistory", "sessions%2fhistory", "pane/commands/", "workspace/directories/"]) {
      const response = await handleMachineRequest(new Request(`${base}/${path}${query}`), manager, undefined, undefined, readOnly);
      expect([readOnly, path, response.status]).toEqual([readOnly, path, 404]);
    }
  }
  expect(historyAsked).toEqual([]);
  // a driving device gets the PC's answer, asked with the PC's credential
  const driven = await handleMachineRequest(new Request(`${base}/sessions/history${query}`), manager);
  expect(driven.status).toBe(200);
  expect(JSON.stringify(await driven.json())).toContain("a private prompt");
  expect(historyAsked).toEqual(["Bearer remote-token"]);
});

it("never asks a PC for a pane's or a folder's command rows for a watching device (#2132)", async () => {
  const base = "http://127.0.0.1/api/machines/pc1";
  for (const path of ["pane/commands?pane_id=w1:p1", "agent/commands?agent=claude"]) {
    const watched = await handleMachineRequest(new Request(`${base}/${path}`), manager, undefined, undefined, true);
    expect([path, watched.status, ((await watched.json()) as { error: { code: string } }).error.code]).toEqual([path, 403, "read_only"]);
  }
  expect(commandsAsked).toEqual([]);
  // a driving device gets the PC's rows
  const driven = await handleMachineRequest(new Request(`${base}/pane/commands?pane_id=w1:p1`), manager);
  expect(driven.status).toBe(200);
  expect(JSON.stringify(await driven.json())).toContain("SECRET");
  expect(commandsAsked).toEqual(["/api/pane/commands"]);
});

it("passes on a PC's 503 with its Retry-After, so the menu knows to ask again (#2254)", async () => {
  const busy = await handleMachineRequest(new Request("http://127.0.0.1/api/machines/pc1/pane/commands?pane_id=busy"), manager);
  expect(busy.status).toBe(503);
  expect(busy.headers.get("retry-after")).toBe("1");
  expect(((await busy.json()) as { error: { code: string } }).error.code).toBe("file_busy");
});

it("never asks a PC for the paths under a pane's folder or a plugin run's output for a watching device (#2244)", async () => {
  const base = "http://127.0.0.1/api/machines/pc1";
  const routes = ["pane/files?pane_id=w1:p1&q=env", "plugin/action?plugin_id=deploy&log_id=plugin-log-1"];
  for (const path of routes) {
    const watched = await handleMachineRequest(new Request(`${base}/${path}`), manager, undefined, undefined, true);
    expect([path, watched.status, ((await watched.json()) as { error: { code: string } }).error.code]).toEqual([path, 403, "read_only"]);
  }
  expect(filesAsked).toEqual([]);
  // a driving device gets the PC's answers
  for (const path of routes) {
    const driven = await handleMachineRequest(new Request(`${base}/${path}`), manager);
    expect([path, driven.status, JSON.stringify(await driven.json()).includes("SECRET")]).toEqual([path, 200, true]);
  }
  expect(filesAsked).toEqual(["/api/pane/files", "/api/plugin/action"]);
});

it("never asks a PC for a repository's checkouts for a watching device (#2250)", async () => {
  const url = "http://127.0.0.1/api/machines/pc1/worktree/list?workspace_id=w1";
  const watched = await handleMachineRequest(new Request(url), manager, undefined, undefined, true);
  expect([watched.status, ((await watched.json()) as { error: { code: string } }).error.code]).toEqual([403, "read_only"]);
  expect(worktreesAsked).toEqual([]);
  // a driving device gets the PC's answer
  const driven = await handleMachineRequest(new Request(url), manager);
  expect([driven.status, JSON.stringify(await driven.json()).includes("SECRET")]).toEqual([200, true]);
  expect(worktreesAsked).toEqual(["/api/worktree/list"]);
});

it("forwards conversation images and complete output, while rejecting arbitrary nested paths", async () => {
  const base = "http://127.0.0.1/api/machines/pc1/pane/conversation";
  const image = await handleMachineRequest(new Request(`${base}/image?pane_id=w1:p1&ref=asset`), manager);
  expect(image.status).toBe(200);
  expect(image.headers.get("content-type")).toBe("image/png");
  expect([...new Uint8Array(await image.arrayBuffer())]).toEqual([137, 80, 78, 71]);
  const output = await handleMachineRequest(new Request(`${base}/tool-output?pane_id=w1:p1&ref=call`), manager);
  expect(output.status).toBe(200);
  expect(await output.text()).toBe("complete remote output");
  expect((await handleMachineRequest(new Request(`${base}/unknown`), manager)).status).toBe(404);
});

it("opens a PC's file from a navigation another site started, and keeps every other route to this app", async () => {
  // Chrome on Android shows a PDF in the viewer's frame as an "Open" button; its navigation is cross-site
  const file = "http://127.0.0.1/api/machines/pc1/fs/file?path=%2Ftmp%2Freport.pdf";
  for (const site of ["cross-site", "same-site"]) {
    const response = await handleMachineRequest(new Request(file, { headers: { "sec-fetch-site": site, "sec-fetch-mode": "navigate" } }), manager);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/pdf");
    expect(await response.text()).toBe("%PDF-1.7");
  }
  const head = await handleMachineRequest(new Request(file, { method: "HEAD", headers: { "sec-fetch-site": "cross-site", "sec-fetch-mode": "navigate" } }), manager);
  // another page loading the file as a picture (a rendered HTML page probing which files exist) is not a navigation
  const probe = await handleMachineRequest(new Request(file, { headers: { "sec-fetch-site": "cross-site", "sec-fetch-mode": "no-cors", "sec-fetch-dest": "image" } }), manager);
  expect(probe.status).toBe(403);
  expect((await probe.json()).error.code).toBe("cross_site");
  expect(head.status).toBe(200);
  expect(head.headers.get("content-type")).toBe("application/pdf");
  const crossSite = { "sec-fetch-site": "cross-site" };
  for (const request of [
    new Request("http://127.0.0.1/api/machines/pc1/fs/stat?path=%2Ftmp%2Freport.pdf", { headers: crossSite }),
    new Request("http://127.0.0.1/api/machines/pc1/pane/conversation?pane_id=w1%3Ap1", { headers: crossSite }),
    new Request(file, { method: "POST", headers: { ...crossSite, "x-herdr-machine": "1" } }),
    new Request(file, { headers: { origin: "https://evil.invalid", "sec-fetch-site": "same-origin" }, method: "PUT" }),
  ]) {
    const response = await handleMachineRequest(request, manager);
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: { code: "invalid_origin" } });
  }
});

it("asks a PC for a folder's project icon once, with the bridge's own credential, and only from this app", async () => {
  const search = `?root=${encodeURIComponent("/home/u/my app")}`;
  const response = await handleMachineRequest(new Request(`http://127.0.0.1/api/machines/pc1/fs/favicon${search}`, { headers: { cookie: "ovis_token=browser-secret" } }), manager);
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.json()).toEqual({ icon: null });
  expect(faviconAsked).toEqual([{ search, authorization: "Bearer remote-token", cookie: null }]);
  // unlike a file itself, it is never opened by a navigation from another site
  const crossSite = await handleMachineRequest(new Request(`http://127.0.0.1/api/machines/pc1/fs/favicon${search}`, { headers: { "sec-fetch-site": "cross-site", "sec-fetch-mode": "navigate" } }), manager);
  expect(crossSite.status).toBe(403);
  expect(await crossSite.json()).toMatchObject({ error: { code: "invalid_origin" } });
  expect(faviconAsked).toHaveLength(1);
});

it("refuses a path with an empty segment instead of forwarding it as another route", async () => {
  const before = asked.length;
  for (const path of ["pc1//fs/file?path=%2Fetc%2Fhostname", "pc1/fs//file?path=%2Fetc%2Fhostname", "pc1//session"]) {
    expect((await handleMachineRequest(new Request(`http://127.0.0.1/api/machines/${path}`), manager)).status).toBe(404);
  }
  expect(asked.length).toBe(before);
});

it("forwards a repository diff read with its query and the bridge's own credential, and nothing of the browser's", async () => {
  const before = diffAsked.length;
  const search = "?pane_id=w1%3Ap1&scope=commit&base=HEAD~1&path=dir%20with%20space%2Fa.txt";
  for (const route of ["files", "file", "repositories", "refs"]) {
    const response = await handleMachineRequest(new Request(`http://127.0.0.1/api/machines/pc1/workspace/diff/${route}${search}`, {
      headers: { cookie: "ovis_token=browser-secret; ovis_device=device-secret", authorization: "Bearer browser-secret", "x-forwarded-for": "203.0.113.9" },
    }), manager);
    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ files: [], total: 0, truncated: false });
  }
  expect(diffAsked.slice(before)).toEqual(["files", "file", "repositories", "refs"].map((route) => ({ path: `/api/workspace/diff/${route}`, search, authorization: "Bearer remote-token", cookie: null, forwarded: null })));
  // only the four reads are routes: nothing else under that name reaches the PC
  for (const path of ["workspace/diff", "workspace/diff/file/extra", "workspace/diff/apply", "workspace/diffs/file"]) {
    const response = await handleMachineRequest(new Request(`http://127.0.0.1/api/machines/pc1/${path}${search}`), manager);
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: { code: "not_found" } });
  }
  const crossSite = await handleMachineRequest(new Request(`http://127.0.0.1/api/machines/pc1/workspace/diff/file${search}`, { headers: { "sec-fetch-site": "cross-site", "sec-fetch-mode": "navigate" } }), manager);
  expect(crossSite.status).toBe(403);
  expect(await crossSite.json()).toMatchObject({ error: { code: "invalid_origin" } });
  expect(diffAsked.length).toBe(before + 4);
});

it("gives a watching device a PC's plan card without Claude's plan file, even from a PC that ignores the ask", async () => {
  const before = promptAsked.length;
  const poll = async (pane: string, readOnly: boolean) => {
    const response = await handleMachineRequest(new Request(`http://127.0.0.1/api/machines/pc1/pane/prompt?pane_id=${pane}`), manager, undefined, undefined, readOnly);
    expect(response.status).toBe(200);
    return (await response.json()) as { prompt: Record<string, unknown> };
  };
  for (const pane of ["w1%3Ap1", "old"]) {
    const watched = await poll(pane, true);
    expect(watched.prompt).toMatchObject({ kind: "plan", question: "Would you like to proceed?", options: [{ label: "Yes", description: null }] });
    expect(watched.prompt).not.toHaveProperty("plan_file");
    expect(JSON.stringify(watched)).not.toContain("secret step");
  }
  // a device that can drive still gets the whole plan
  expect((await poll("w1%3Ap1", false)).prompt).toMatchObject({ plan_file: "/home/u/.claude/plans/p.md", body: "1. A secret step from the plan file." });
  expect(promptAsked.slice(before)).toEqual(["0", "0", null]);
});

it("passes a PC's session on without the token values this server's sidebar rows hide (#2160)", async () => {
  const rows = agentRowTokens(Bun.TOML.parse(`[ui.sidebar.agents]\nrows = [[{ token = "$quota", rules = [{ starts_with = "off", hide = true }] }, "$eta"]]`));
  const sidebar = { get: () => rows, subscribe: () => () => undefined };
  for (const readOnly of [true, false]) {
    const response = await handleMachineRequest(new Request("http://127.0.0.1/api/machines/pc1/session"), manager, undefined, undefined, readOnly, sidebar);
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).not.toContain("off · private");
    expect((JSON.parse(text) as { snapshot: { panes: { tokens: unknown }[] } }).snapshot.panes[0]!.tokens).toEqual({ eta: "soon" });
  }
  // any other method the PC answers with a body is filtered too (its session route takes them all)
  const asked = await handleMachineRequest(new Request("http://127.0.0.1/api/machines/pc1/session", { method: "OPTIONS", headers: { "x-herdr-machine": "1" } }), manager, undefined, undefined, true, sidebar);
  expect(await asked.text()).not.toContain("off · private");
  // a HEAD has no body to filter: it is answered as before
  expect((await handleMachineRequest(new Request("http://127.0.0.1/api/machines/pc1/session", { method: "HEAD" }), manager, undefined, undefined, true, sidebar)).status).toBe(200);
  // a server whose config names no rows passes the session on whole
  const whole = await handleMachineRequest(new Request("http://127.0.0.1/api/machines/pc1/session"), manager, undefined, undefined, true, { get: () => null, subscribe: () => () => undefined });
  expect(await whole.text()).toContain("off · private");
});
