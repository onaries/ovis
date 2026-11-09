import { expect, it } from "bun:test";

import { probeUntilReachable, reachabilityProbe, REPROBE_MS } from "./AccountSection.tsx";

// the relay tab offers the relay's own pairing while the account service cannot be reached (ConnectPhoneDialog's RelayTab)
it("counts an answer the service could give as reachable, and a server error or no answer as not", async () => {
  const seen: boolean[] = [];
  const answering = (status: number) => reachabilityProbe((reachable) => seen.push(reachable), Object.assign(async () => new Response(null, { status }), { preconnect: fetch.preconnect }));
  await answering(200)("https://account.example/v1/providers");
  await answering(404)("https://account.example/v1/providers");
  await answering(503)("https://account.example/v1/providers");
  await answering(502)("https://account.example/v1/providers");
  const offline = reachabilityProbe((reachable) => seen.push(reachable), Object.assign(async (): Promise<Response> => { throw new TypeError("offline"); }, { preconnect: fetch.preconnect }));
  await expect(offline("https://account.example/v1/providers")).rejects.toThrow("offline");
  expect(seen).toEqual([true, true, false, false, false]);
});

it("asks an account service that did not answer again, sooner first, until it answers, and stops when told", async () => {
  const flush = async () => { for (let turn = 0; turn < 5; turn += 1) await Promise.resolve(); };
  const waits: number[] = [];
  let next: (() => void) | null = null;
  const timers = { set: (run: () => void, ms: number) => { waits.push(ms); next = run; return ms; }, clear: () => { next = null; } };
  const answers = [false, false, false, false, true];
  let asked = 0;
  probeUntilReachable(async () => answers[asked++]!, timers);
  for (let turn = 0; turn < 4; turn += 1) { await flush(); next!(); }
  await flush();
  expect(asked).toBe(5);
  expect(waits).toEqual([REPROBE_MS[0], REPROBE_MS[1], REPROBE_MS[2], REPROBE_MS[2]]);
  // stopped (Settings closed, or a new probe took over): nothing is asked again
  asked = 0;
  waits.length = 0;
  const stop = probeUntilReachable(async () => { asked += 1; return false; }, timers);
  await flush();
  stop();
  expect(next).toBeNull();
  expect(asked).toBe(1);
});
