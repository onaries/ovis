import assert from "node:assert/strict";
import { chromium } from "playwright-core";
import { chromePath } from "./chrome-path.ts";

const build = await Bun.build({ entrypoints: ["src/lib/voice.ts"], target: "browser", define: { "process.env.NODE_ENV": '"production"' } });
assert.ok(build.success, String(build.logs));
const script = await build.outputs[0]!.text();
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: request => new URL(request.url).pathname === "/voice.js"
  ? new Response(script, { headers: { "content-type": "application/javascript" } })
  : new Response("<html><body>Voice preparation regression</body></html>", { headers: { "content-type": "text/html" } }) });
const browser = await chromium.launch({ executablePath: chromePath(), headless: true, args: ["--no-sandbox", "--autoplay-policy=user-gesture-required", "--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"] });
try {
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${server.port}`);
  const states = await page.evaluate(async () => {
    const { createVoiceEngine } = await import("/voice.js");
    const states: string[] = [];
    const errors: string[] = [];
    let elapsed = 0;
    const contexts: AudioContext[] = [];
    const NativeAudioContext = window.AudioContext;
    window.AudioContext = class extends NativeAudioContext {
      constructor() { super(); contexts.push(this); }
    };
    const getUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async constraints => {
      const stream = await getUserMedia(constraints);
      // Permission/OS interruptions can suspend WebAudio while the microphone is opening.
      await contexts[0]?.suspend();
      return stream;
    };
    let uploaded = false;
    window.fetch = async () => { uploaded = true; return new Response('{"type":"done","text":"test"}\n'); };
    const voice = createVoiceEngine({
      setState: (state: string) => states.push(state), setElapsed: (value: number) => { elapsed = value; }, setSilent: () => {},
      setError: (error: string | null) => { if (error) errors.push(error); },
      options: () => ({ mode: "chat", enabled: true, polish: false, onText: () => {} }),
      engine: () => "server", language: () => ({ locale: "en-US", ui: "en" }),
      recorder: () => ({ mimeType: "audio/webm;codecs=opus", extension: "webm" }), speech: () => null,
    });
    try {
      voice.prewarm();
      voice.press();
      await new Promise<void>((resolve, reject) => {
        const deadline = performance.now() + 5000;
        const frame = () => {
          if (states.includes("recording") && elapsed >= 2000) resolve();
          else if (performance.now() > deadline) reject(new Error(`Stuck: ${states.join(",")}`));
          else requestAnimationFrame(frame);
        };
        frame();
      });
      voice.finish();
      await new Promise<void>((resolve, reject) => {
        const deadline = performance.now() + 5000;
        const frame = () => {
          if (states.at(-1) === "idle") resolve();
          else if (performance.now() > deadline) reject(new Error("Recording never finished"));
          else requestAnimationFrame(frame);
        };
        frame();
      });
      if (!uploaded) throw new Error(`Microphone audio discarded: ${errors.join(",")}`);
      return states;
    } finally { voice.cancel(); }
  });
  assert.ok(states.includes("recording"), JSON.stringify(states));
  console.log("PASS real Chromium microphone leaves preparing", states);
} finally { await browser.close(); server.stop(true); }
