import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { TELEMETRY_ACTION_SOURCES, TELEMETRY_ACTIONS, TELEMETRY_COUNTERS, TELEMETRY_SHOWN } from "./telemetry.ts";
import { COUNTS_ON, NOTICE_VERSION } from "./telemetry-notice.ts";

const root = join(import.meta.dir, "..");
const read = (path: string) => readFileSync(join(root, path), "utf8");

/**
 * source as it runs: block comments, whole-line and trailing line comments out (a "//" after ":" is a URL's and
 * stays), so a sentence in a comment says nothing
 */
const code = (source: string) => source.replace(/\/\*[\s\S]*?\*\//g, "").split("\n").map((line) => line.replace(/(^|[^:])\/\/.*$/, "$1")).join("\n");
/** a page as it is read: HTML comments and scripts out */
const html = (source: string) => source.replace(/<!--[\s\S]*?-->/g, "").replace(/<script\b[\s\S]*?<\/script>/gi, "");
/** the guide's own section on the counts, up to the next heading of its level */
const guideSection = (source: string) => {
  const start = source.indexOf("\n## Anonymous usage counts\n");
  if (start < 0) return "";
  const end = source.indexOf("\n## ", start + 1);
  return html(source.slice(start, end < 0 ? undefined : end));
};
const controls = code(read("src/components/TelemetryControls.tsx"));
/** the one table row of a store form that starts so */
const row = (source: string, start: string) => html(source).split("\n").find((line) => line.startsWith(start)) ?? "";

// The button counts may be on only in a tree whose every disclosure says they are sent: the notice line the app
// shows, the Settings description of the switch, the guide's section, both privacy pages and both store forms. A build that turns
// them on without those words fails here, and so does one that says so while they are off.
describe("button counts and the words that disclose them", () => {
  test("COUNTS_ON only where the notice, Settings, the guide, both privacy pages and both store forms say buttons are counted", () => {
    // each says, beside the buttons, the two other things the message holds: for a few actions which way (button, menu,
    // shortcut, palette) they were done, and which controls were shown that day
    const has = (text: string, ...phrases: string[]) => phrases.every((phrase) => text.includes(phrase));
    /** the part of a sentence from `from` to the end of `to`, or nothing when either is missing */
    const clause = (text: string, from: string, to: string) => {
      const start = text.indexOf(from);
      const end = start < 0 ? -1 : text.indexOf(to, start);
      return end < 0 ? "" : text.slice(start, end + to.length);
    };
    const settingsRow = /:\s*<SettingsRow label=\{t\("Send anonymous usage counts"\)\}[^\n]*description=\{t\("([^"]*)"\)/.exec(controls)?.[1] ?? "";
    // the same Settings sentence as each translation shows it: the two items by short words of that language
    const translation = (language: string) => read(`src/lib/i18n/settings.${language}.ts`).split("\n").find((line) => line.startsWith(`  ${JSON.stringify(settingsRow)}: "`))?.slice(settingsRow.length + 6) ?? "";
    const iosRow = row(read("app/store/ios.md"), "| Usage Data > Product Interaction");
    const androidRow = row(read("app/store/android.md"), "| App activity > App interactions");
    const said = {
      notice: /:\s*t\("Button use and other anonymous usage counts are sent to improve Ovis\."\)/.test(controls),
      // the row that holds the switch (the ": <SettingsRow" branch), not the one shown when the environment blocks counting
      // the four ways, each by its own short word, inside the part of the sentence on the button counts (the custom
      // shortcuts named later in it do not count), and the shown list after them
      settings: has(clause(settingsRow, "After each day, how often the app's buttons were used that day", "controls were shown"), "a button", "a menu", "a shortcut", "command palette"),
      settingsKo: has(clause(translation("ko"), "그날 앱의 버튼을", "화면에 나왔는지"), "버튼·", "메뉴", "단축키", "명령 팔레트"),
      settingsJa: has(clause(translation("ja"), "アプリのボタンを", "表示された"), "ボタン・", "メニュー", "ショートカット", "コマンドパレット"),
      settingsZh: has(clause(translation("zh"), "应用各按钮", "曾显示"), "通过按钮", "菜单", "快捷键", "命令面板"),
      guide: guideSection(read("docs/guide.md")).includes("a counts message goes out once for that day"),
      privacy: has(html(read("ovis-site/privacy/index.html")), "how often the app's buttons were used that day", "a keyboard shortcut or the command palette was used", "which of these controls were shown that day"),
      privacyKo: has(html(read("ovis-site/ko/privacy/index.html")), "그날 앱의 버튼을 얼마나 썼는지", "버튼·메뉴·단축키·명령 팔레트 중 무엇으로 했는지", "무엇이 그날 화면에 나왔는지"),
      // the store forms: the Product Interaction / App interactions rows, where the stores' own disclosure is drawn from
      storeIos: has(iosRow, "how often its buttons are used", "whether by button, menu, shortcut or palette", "which of them were shown"),
      storeAndroid: has(androidRow, "how often the app's buttons were used", "whether by button, menu, shortcut or palette", "which of these controls were shown"),
    };
    const all = (value: boolean) => ({ notice: value, settings: value, settingsKo: value, settingsJa: value, settingsZh: value, guide: value, privacy: value, privacyKo: value, storeIos: value, storeAndroid: value });
    expect(said).toEqual(all(COUNTS_ON));
  });

  // What the disclosures above describe, as it was when they were last read against it: every counter, action, way
  // and shown control. A name added or changed fails here until the notice, Settings, the guide, both privacy pages
  // and both store forms are read again (a new kind of data needs a new NOTICE_VERSION, and the owner's word), and
  // this line is updated with them.
  test("the names counted are the ones the disclosures were last read against", () => {
    const names = JSON.stringify([TELEMETRY_COUNTERS, TELEMETRY_ACTIONS, TELEMETRY_ACTION_SOURCES, TELEMETRY_SHOWN]);
    const disclosed = { notice: NOTICE_VERSION, names: createHash("sha256").update(names).digest("hex").slice(0, 16) };
    expect(disclosed).toEqual({ notice: 6, names: "7cbe7c28d10e0d94" });
  });
});
