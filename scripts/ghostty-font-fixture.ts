import { Terminal } from "@xterm/xterm";
import { attachGhosttyOverlay } from "../src/lib/ghostty/overlay.ts";
import "@xterm/xterm/css/xterm.css";
import "../src/components/PaneTerminal.css";

const host = document.querySelector<HTMLDivElement>("#terminal");
if (!host) throw new Error("terminal fixture mount missing");
const font = new URLSearchParams(location.search).get("font") ?? "monospace";
const dark = new URLSearchParams(location.search).get("dark") === "true";
const term = new Terminal({ cols: 42, rows: 12, fontSize: 14, fontFamily: font, scrollback: 0,
  theme: { background: dark ? "#171717" : "#fafafa", foreground: dark ? "#eeeeee" : "#222222" } });
term.open(host);
const output = "\x1b[H\x1b[2JWorking for 55s\r\n한글과 English 123\r\n\x1b[32mGREEN\x1b[0m normal tail\r\nWiWiWiWi\r\n";
void new Promise<void>(resolve => term.write(output, resolve)).then(async () => {
  try {
    await attachGhosttyOverlay(term, host, () => [output]);
  } catch (error) {
    host.dataset["fallback"] = error instanceof Error ? error.message : String(error);
  }
  Reflect.set(window, "fontFixture", { term, ready: true });
});
