import { afterEach, expect, spyOn, test } from "bun:test";
import { generateKeyPair, exportPublicKey } from "../../../shared/relay-e2ee.ts";
import { encodeOffer } from "../../../shared/relay-offer.ts";
import { deriveServerId } from "../../../shared/relay-server-proof.ts";
import { importPublicKey } from "../../../shared/relay-e2ee.ts";
import { nativeTransport, setTransport } from "../transport.ts";
import { listThisPc } from "./addThisPc.ts";
import type { AccountService } from "./service.ts";

afterEach(() => setTransport(nativeTransport));

test("a failure of the relay pass setup never keeps Add this PC from its pairing wait", async () => {
  const keys = generateKeyPair();
  const publicKey = exportPublicKey(keys.publicKey);
  const serverId = deriveServerId(importPublicKey(publicKey));
  const asked: string[] = [];
  const answer = async (input: RequestInfo | URL): Promise<Response> => {
    const path = new URL(String(input), "http://localhost").pathname;
    asked.push(path);
    if (path === "/api/relay/link") return Response.json({ url: encodeOffer({ v: 1, server_id: serverId, server_public_key: publicKey, relay: "wss://relay.ovis.sh", name: "desk" }, "https://app.ovis.sh") });
    return Response.json({ error: { code: "internal", message: "relay/account.json is not writable" } }, { status: 500 });
  };
  setTransport({ ...nativeTransport, fetch: answer });
  const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(answer as typeof fetch);
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  const listed: string[] = [];
  const service = { listPcs: async () => [], putPc: async (id: string) => { listed.push(id); }, deletePc: async () => {}, session: async () => ({ account: "acct_1" }) } as unknown as AccountService;
  try {
    expect(await listThisPc(service, { relistMs: 540_000 })).toBe("desk");
    expect(listed).toEqual([serverId]);
    expect(asked).toContain("/api/account/relay-account");
  } finally { fetchSpy.mockRestore(); warn.mockRestore(); }
});

test("a pass setup that never answers does not hold Add this PC either", async () => {
  const keys = generateKeyPair();
  const publicKey = exportPublicKey(keys.publicKey);
  const serverId = deriveServerId(importPublicKey(publicKey));
  const asked: string[] = [];
  const answer = async (input: RequestInfo | URL): Promise<Response> => {
    const path = new URL(String(input), "http://localhost").pathname;
    asked.push(path);
    if (path === "/api/relay/link") return Response.json({ url: encodeOffer({ v: 1, server_id: serverId, server_public_key: publicKey, relay: "wss://relay.ovis.sh", name: "desk" }, "https://app.ovis.sh") });
    return new Promise<Response>(() => {});
  };
  setTransport({ ...nativeTransport, fetch: answer });
  const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(answer as typeof fetch);
  const service = { listPcs: async () => [], putPc: async () => {}, deletePc: async () => {}, session: async () => ({ account: "acct_1" }) } as unknown as AccountService;
  try {
    expect(await listThisPc(service, { relistMs: 540_000 })).toBe("desk");
    expect(asked).toContain("/api/account/relay-account");
  } finally { fetchSpy.mockRestore(); }
});
