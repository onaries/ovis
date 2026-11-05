import { expect, it } from "bun:test";
import { accountServiceOf, startLoopbackSignIn } from "./accountSignIn.ts";

it("signs in with account.ovis.sh unless OVIS_ACCOUNT_SERVICE_URL names another https service or is off", () => {
  expect(accountServiceOf({})).toBe("https://account.ovis.sh");
  expect(accountServiceOf({ OVIS_ACCOUNT_SERVICE_URL: "https://account.example/v1/" })).toBe("https://account.example");
  expect(accountServiceOf({ OVIS_ACCOUNT_SERVICE_URL: "off" })).toBeNull();
  expect(accountServiceOf({ OVIS_ACCOUNT_SERVICE_URL: "http://account.example" })).toBeNull();
});

it("hands back the callback's query once the browser returns with the expected state, and stops listening", async () => {
  const signIn = await startLoopbackSignIn();
  signIn.expect("s1");
  expect(signIn.redirectUri).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);
  const page = await fetch(`${signIn.redirectUri}?code=abc&state=s1`);
  expect(page.status).toBe(200);
  expect(await signIn.returned).toBe("code=abc&state=s1");
  await expect(fetch(`${signIn.redirectUri}?code=again&state=s1`)).rejects.toThrow();
});

it("turns away anything but this sign-in's own return, and keeps waiting for it", async () => {
  const signIn = await startLoopbackSignIn();
  signIn.expect("s2");
  const origin = new URL(signIn.redirectUri).origin;
  expect((await fetch(`${origin}/`)).status).toBe(404);
  expect((await fetch(`${origin}/callback?state=s2`)).status).toBe(404);
  // another sign-in's return, or a forged one, ends nothing
  expect((await fetch(`${signIn.redirectUri}?code=other&state=bogus`)).status).toBe(404);
  await fetch(`${signIn.redirectUri}?error=access_denied&state=s2`);
  expect(await signIn.returned).toBe("error=access_denied&state=s2");
});

it("leaves one sign-in when two start at once, and gives up the one a new one replaces", async () => {
  const [first, second] = await Promise.allSettled([startLoopbackSignIn(), startLoopbackSignIn()]);
  expect(first.status).toBe("rejected");
  expect(second.status).toBe("fulfilled");
  if (second.status !== "fulfilled") return;
  const third = await startLoopbackSignIn();
  await expect(second.value.returned).rejects.toThrow("replaced");
  third.close();
});
