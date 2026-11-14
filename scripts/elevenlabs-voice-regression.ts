import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { chromium } from "playwright-core";
import { buildDemoApp } from "./demo-build.ts";
import { chromePath } from "./chrome-path.ts";
import { openSettingsFolds } from "./settings-page.ts";
import { VOICE_DEFAULTS } from "../shared/voice.ts";
import { VoiceService, handleVoiceRequest } from "../server/voice.ts";

const root = mkdtempSync(join(tmpdir(), "ovis-elevenlabs-"));
const evidence = process.env.UI_EVIDENCE_DIR || process.env.OVIS_QA_DIR || join(root, "evidence");
mkdirSync(evidence, { recursive: true });
try {
  await buildDemoApp(root);
  const voice = new VoiceService({ stateDir: join(root, "state"), env: {}, fetch: async () => Response.json({ text: "test" }) });
  const html = readFileSync(join(root, "index.html"), "utf8").replace('<script type="module"', '<script>window.nativeFetch = window.fetch.bind(window)</script><script src="./demo-transport.js"></script><script>const demoFetch = window.fetch; window.fetch = (input, init) => new URL(typeof input === "string" ? input : input.url, location.href).pathname.startsWith("/api/voice") ? window.nativeFetch(input, init) : demoFetch(input, init)</script><script type="module"');
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    const path = new URL(request.url).pathname;
    if (path.startsWith("/api/voice")) return handleVoiceRequest(request, path, voice);
    return path === "/" ? new Response(html, { headers: { "content-type": "text/html" } }) : new Response(Bun.file(join(root, path.slice(1))));
  } });
  try {
    const browser = await chromium.launch({ executablePath: chromePath(), headless: true, args: ["--no-sandbox"] });
    try {
      for (const width of [390, 1440]) for (const theme of ["light", "dark"]) {
        voice.update({ api_key: null });
        voice.update({ provider: "openai", base_url: VOICE_DEFAULTS.base_url, transcribe_model: VOICE_DEFAULTS.transcribe_model });
        const page = await browser.newPage({ viewport: { width, height: 900 }, locale: "en" });
        const errors: string[] = [];
        page.on("pageerror", error => errors.push(error.message));
        await page.addInitScript(({ theme }) => localStorage.setItem("ovis:settings", JSON.stringify({ language: "en", voiceInput: "on", voiceEngine: "server", theme })), { theme });
        await page.goto(`http://127.0.0.1:${server.port}/?settings=chat`);
        await page.locator(".conn-live").waitFor({ state: "attached" });
        await openSettingsFolds(page);
        const provider = page.getByLabel("STT provider", { exact: true });
        await provider.selectOption("elevenlabs");
        assert.equal(await page.getByLabel("STT model", { exact: true }).inputValue(), "scribe_v2");
        await page.getByRole("textbox", { name: "API key", exact: true }).fill("elevenlabs-test-key");
        await page.locator(".voice-key-save").click();
        await page.waitForFunction(() => document.querySelector<HTMLInputElement>(".voice-key-input")?.value === "");
        assert.equal(voice.status().provider, "elevenlabs");
        await page.goto(`http://127.0.0.1:${server.port}/?settings=chat`);
        await openSettingsFolds(page);
        assert.equal(await provider.inputValue(), "elevenlabs");
        await provider.scrollIntoViewIfNeeded();
        await page.screenshot({ path: join(evidence, `${width}-${theme}.png`) });
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
        await provider.selectOption("openai");
        assert.equal(await page.locator(".voice-key-save").isDisabled(), true);
        assert.deepEqual(errors, []);
        await page.close();
        console.log(`PASS ElevenLabs settings save, reload, key protection and layout ${width} ${theme}`);
      }
    } finally { await browser.close(); }
  } finally { server.stop(true); }
} finally { rmSync(root, { recursive: true, force: true }); }
