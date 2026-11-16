import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { COUNTS_ON } from "./telemetry-notice.ts";

const root = join(import.meta.dir, "..");
const read = (path: string) => readFileSync(join(root, path), "utf8");

/** source as it runs: comment lines and HTML comments out, so a sentence in a comment says nothing */
const code = (source: string) => source.split("\n").filter((line) => !/^\s*(\/\/|\/\*|\*)/.test(line)).join("\n");
const html = (source: string) => source.replace(/<!--[\s\S]*?-->/g, "");
/** the guide's own section on the counts, up to the next heading of its level */
const guideSection = (source: string) => {
  const start = source.indexOf("\n## Anonymous usage counts\n");
  if (start < 0) return "";
  const end = source.indexOf("\n## ", start + 1);
  return source.slice(start, end < 0 ? undefined : end);
};
const controls = code(read("src/components/TelemetryControls.tsx"));

// The button counts may be on only in a tree whose every disclosure says they are sent: the notice line the app
// shows, the Settings description of the switch, the guide's section, and both privacy pages. A build that turns
// them on without those words fails here, and so does one that says so while they are off.
describe("button counts and the words that disclose them", () => {
  test("COUNTS_ON only where the notice, Settings, the guide and both privacy pages say buttons are counted", () => {
    const said = {
      notice: /:\s*t\("Button use and other anonymous usage counts are sent to improve Ovis\."\)/.test(controls),
      settings: /label=\{t\("Send anonymous usage counts"\)\}[^\n]*description=\{t\("[^"]*After each day, how often the app's buttons were used that day[^"]*"\)/.test(controls),
      guide: guideSection(read("docs/guide.md")).includes("a counts message goes out once for that day"),
      privacy: html(read("ovis-site/privacy/index.html")).includes("how often the app's buttons were used that day"),
      privacyKo: html(read("ovis-site/ko/privacy/index.html")).includes("그날 앱의 버튼을 얼마나 썼는지"),
    };
    const all = (value: boolean) => ({ notice: value, settings: value, guide: value, privacy: value, privacyKo: value });
    expect(said).toEqual(all(COUNTS_ON));
  });
});
