import { expect, it } from "bun:test";
import { GLOBAL_APP, regionalAppReady, regionalAppUrl } from "./relay-regions.ts";

const ID = "0123456789abcdef".repeat(2);
const link = (offer: unknown) => `#offer=${btoa(JSON.stringify(offer)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")}`;
const at = (hash: string, origin = "https://app.ovis.sh", pathname = `/s/${ID}/`) => ({ origin, pathname, hash });
const pairing = { v: 1, server_id: ID, server_public_key: "k", relay: "wss://relay-ap.ovis.sh", code: "123456" };

it("opens a pairing link for a regional relay on the app's copy beside it, the fragment kept", () => {
  const hash = link(pairing);
  expect(regionalAppUrl(at(hash), false)).toBe(`https://app-ap.ovis.sh/s/${ID}/${hash}`);
});

it("leaves every other page where it is", () => {
  for (const [location, native] of [
    [at(link(pairing)), true],
    [at(link({ ...pairing, relay: "wss://relay.ovis.sh" })), false],
    [at(link({ ...pairing, code: undefined })), false],
    [at(link(pairing), "https://app-ap.ovis.sh"), false],
    [at(link(pairing), "https://pc.example.ts.net"), false],
    [at(link(pairing), "https://app.ovis.sh", "/"), false],
    [at(""), false],
    [at("#offer=not*base64"), false],
    [at(link([1])), false],
  ] as const) expect([location, regionalAppUrl(location, native)]).toEqual([location, null]);
});

it("moves only to a copy that answers with the build app.ovis.sh serves", async () => {
  const builds = (here: unknown, there: unknown) => (async (input: string | URL | Request) => {
    const body = String(input).startsWith(GLOBAL_APP) ? here : there;
    if (body instanceof Error) throw body;
    return body === null ? new Response("", { status: 503 }) : Response.json(body);
  }) as typeof fetch;
  const copy = "https://app-ap.ovis.sh";
  expect(await regionalAppReady(copy, builds({ revision: "a" }, { revision: "a" }))).toBe(true);
  expect(await regionalAppReady(copy, builds({ revision: "a" }, { revision: "b" }))).toBe(false);
  expect(await regionalAppReady(copy, builds({ revision: "a" }, null))).toBe(false);
  expect(await regionalAppReady(copy, builds({ revision: "a" }, new TypeError("Failed to fetch")))).toBe(false);
  expect(await regionalAppReady(copy, builds({}, {}))).toBe(false);
});
