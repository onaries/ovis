import { expect, it } from "bun:test";
import { enrollPc } from "./join.ts";
import { memoryAccountStore } from "./store.ts";

it("stops the introduction loop without acknowledging its plan when ownership is lost", async () => {
  const store = memoryAccountStore();
  const plan = { account: "account", done: [], introduce: {
    keys: ["first-key", "second-key"],
    pc: { server_id: "source", server_public_key: "server-key", relay: "wss://relay.invalid", name: "Desk" },
    to: ["peer"],
  } };
  await store.set("enrolls", { source: plan });
  const requested = Promise.withResolvers<void>();
  const response = Promise.withResolvers<Response>();
  const cancellation = new DOMException("Source pairing was forgotten", "AbortError");
  const delivered: unknown[] = [];
  const pending = enrollPc({
    store, account: "account", serverId: "source",
    fetch: async () => { throw new TypeError("An introduction-only retry must not enroll again"); },
    others: [{ serverId: "peer", fetch: async (_path, init) => {
      delivered.push(JSON.parse(String(init?.body)));
      if (delivered.length === 1) { requested.resolve(); return response.promise; }
      return Response.json({});
    } }],
  }).catch((error: unknown) => error);
  await requested.promise;
  response.reject(cancellation);
  expect(await pending).toBe(cancellation);
  expect(delivered).toEqual([{ key: "first-key", pcs: [plan.introduce.pc] }]);
  expect(await store.get("enrolls")).toEqual({ source: plan });
});

it("keeps the pending introduction when ownership is lost at acknowledgement", async () => {
  const store = memoryAccountStore();
  const plan = { account: "account", done: [], introduce: {
    keys: ["last-key"], pc: { server_id: "source", server_public_key: "server-key", relay: "wss://relay.invalid", name: "Desk" }, to: ["peer"],
  } };
  await store.set("enrolls", { source: plan });
  let owned = true;
  const cancellation = new DOMException("Source pairing was forgotten", "AbortError");
  const result = await enrollPc({
    store, account: "account", serverId: "source",
    fetch: async () => { throw new TypeError("An introduction-only retry must not enroll again"); },
    others: [{ serverId: "peer", fetch: async () => { owned = false; return Response.json({}); } }],
    assertOwned: async () => { if (!owned) throw cancellation; },
  }).catch((error: unknown) => error);
  expect(result).toBe(cancellation);
  expect(await store.get("enrolls")).toEqual({ source: plan });
});
