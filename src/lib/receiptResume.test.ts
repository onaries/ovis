import { afterEach, expect, it } from "bun:test";

const KEY = "ovis:pi-receipt-resume";
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const originalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
const originalCrypto = Object.getOwnPropertyDescriptor(globalThis, "crypto");
let load = 0;
const fresh = (): Promise<typeof import("./receiptResume.ts")> => import(`./receiptResume.ts?test=${++load}`);
const storage = (saved: string | null = null) => {
  const values = new Map<string, string>(saved === null ? [] : [[KEY, saved]]);
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
  } });
  return values;
};
afterEach(() => {
  if (originalStorage) Object.defineProperty(globalThis, "localStorage", originalStorage);
  else Reflect.deleteProperty(globalThis, "localStorage");
  if (originalCrypto) Object.defineProperty(globalThis, "crypto", originalCrypto);
});

it("generates a v4 ID without randomUUID on plain-HTTP LAN and persists it across reloads", async () => {
  const values = storage();
  const getRandomValues = crypto.getRandomValues.bind(crypto);
  Object.defineProperty(globalThis, "crypto", { configurable: true, value: { getRandomValues } });
  const page = await fresh();
  const id = page.receiptResumeId();
  expect(id).toMatch(UUID);
  expect(values.get(KEY)).toBe(id);
  expect(page.receiptResumeId()).toBe(id);
  expect((await fresh()).receiptResumeId()).toBe(id);
});

it("persists the secure-context ID too", async () => {
  const values = storage();
  const id = (await fresh()).receiptResumeId();
  expect(id).toMatch(UUID);
  expect(values.get(KEY)).toBe(id);
  expect((await fresh()).receiptResumeId()).toBe(id);
});

it.each(["not a UUID", "-".repeat(36), "a".repeat(36), "00000000-0000-0000-0000-000000000000"])("replaces malformed storage: %s", async (saved) => {
  const values = storage(saved);
  const id = (await fresh()).receiptResumeId();
  expect(id).toMatch(UUID);
  expect(id).not.toBe(saved);
  expect(values.get(KEY)).toBe(id);
});

it("keeps one page-local ID when storage is unavailable", async () => {
  Object.defineProperty(globalThis, "localStorage", { configurable: true, get: () => { throw new Error("denied"); } });
  const page = await fresh();
  const id = page.receiptResumeId();
  expect(id).toMatch(UUID);
  expect(page.receiptResumeId()).toBe(id);
});
