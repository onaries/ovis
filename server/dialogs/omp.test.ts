import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { answerKeys, parseInteractivePrompt } from "../prompt.ts";
import { registry } from "./registry.ts";
import { KEY } from "./shared.ts";

// Screens of omp 18.8.7's /handoff, recorded in an isolated omp home at 119 and 60 columns.
const screen = (step: string, width: "wide" | "narrow") =>
  readFileSync(new URL(`../fixtures/omp-handoff-18.8.7-${step}-${width}.txt`, import.meta.url), "utf8");
const widths = ["wide", "narrow"] as const;

// omp 18.12.6 with `composer.shape: pi`, recorded at 120 and 60 columns in an isolated omp home with a fake model provider:
// omp's status row sits right under the Ask panel's bottom border while the question waits (#1644)
const ask = (name: string) =>
  readFileSync(new URL(`../fixtures/omp-ask-18.12.6-${name}.txt`, import.meta.url), "utf8");
const STATUS_ROW_RE = /\n ?(?:[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] \S+|π) · ⬢ [^\n]*/u;
const card = (screen: string) => {
  const prompt = parseInteractivePrompt("omp", screen);
  return prompt && { kind: prompt.kind, title: prompt.title, question: prompt.question, options: prompt.options, multi_select: prompt.multi_select };
};

describe("omp Ask under omp's status row (#1644)", () => {
  it("keeps the card while the question waits above the status row", () => {
    for (const name of ["single-120", "single-60", "multi-120", "submit-60"]) {
      const shown = ask(name);
      expect(shown, name).toMatch(STATUS_ROW_RE);
      expect(card(shown), name).not.toBeNull();
      expect(card(shown), name).toEqual(card(shown.replace(STATUS_ROW_RE, "")));
    }
    expect(card(ask("single-120"))?.question).toBe("Which route should carry the fictional session?");
    expect(card(ask("multi-120"))).toMatchObject({ question: "Which synthetic targets should be checked?", multi_select: true });
  });

  it("reads a multi-select question whose hint a narrow pane clips inside the cancel label", () => {
    // at 60 columns omp 18.12.6 ends the multi-select hint `⎋ cance…`
    const shown = ask("multi-60");
    expect(shown).toContain("␣ toggle · ⏎ next · ↑/↓ move · ⇥/←/→ question · ⎋ cance…");
    expect(card(shown)).toMatchObject({ question: "Which synthetic targets should be checked?", multi_select: true,
      options: [{ label: "Desktop" }, { label: "Phone" }, { label: "Tablet" }] });
    expect(card(shown)).toEqual(card(shown.replace(STATUS_ROW_RE, "")));
  });

  it("shows no card for an old Ask panel with another, empty box between it and the status row", () => {
    // an answered question can leave its panel on screen while omp draws another box under it
    const box = "\n\u256d\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u256e\n\u2502        \u2502\n\u2570\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u256f";
    for (const name of ["single-120", "submit-60"]) {
      const shown = ask(name);
      const row = shown.match(STATUS_ROW_RE)![0];
      const old = shown.replace(STATUS_ROW_RE, "").replace(/\n+$/, "") + box;
      expect(parseInteractivePrompt("omp", `${old}${row}\n`), name).toBeNull();
      expect(parseInteractivePrompt("omp", `${old}\n \u03c0 \u00b7 \u2b22 Ask fixture \u00b7 \ud83d\uddd1 \u2026/home/fixture \u00b7 \u25eb 5.7%/131K \u27f2\n`), `${name} at rest`).toBeNull();
    }
  });

  it("shows no card once the panel was answered and later output came above the status row", () => {
    expect(parseInteractivePrompt("omp", ask("settled-60"))).toBeNull();
  });

  it("lets a status row pass only right under the panel's bottom border", () => {
    const shown = ask("single-120");
    // later output between the panel's bottom border and the status row
    const moved = shown.replace(STATUS_ROW_RE, "\n Fixture output after the panel.$&");
    expect(moved).not.toBe(shown);
    expect(parseInteractivePrompt("omp", moved)).toBeNull();
    // nor right under the hint with no border between them: the row alone proves nothing
    const unbordered = shown.replace(/\n\u2570\u2500+\u256f(?=\n ?(?:[\u280b\u2819\u2839\u2838\u283c\u2834\u2826\u2827\u2807\u280f] |\u03c0 ))/u, "");
    expect(unbordered).not.toBe(shown);
    expect(parseInteractivePrompt("omp", unbordered)).toBeNull();
  });
});

describe("omp /handoff", () => {
  it("reads the generating status, with and without focus instructions, as a card that cancels with Esc", () => {
    for (const width of widths) {
      for (const step of ["generating", "generating-args"]) {
        const prompt = parseInteractivePrompt("omp", screen(step, width));
        expect(prompt, `${step} ${width}`).toMatchObject({
          agent: "omp", kind: "menu", question: "Generating handoff…", options: [{ label: "Cancel", description: null }],
          multi_select: false, custom_option_index: null,
        });
        // its title and Cancel are the bridge's, as keys the client translates (#1482); the status line is omp's
        expect(prompt!.own_text).toEqual({ title: { key: "Handoff" }, labels: { 0: { key: "Cancel" } } });
        expect(answerKeys(prompt!, { option_index: 0 })).toEqual([{ keys: [KEY.escape] }]);
      }
    }
  });

  it("is answered by the omp-handoff reader, which reads the screen again before Esc", () => {
    const reader = registry.readerFor("omp-handoff");
    expect(reader?.reread).toBe("before-commit");
    expect(reader?.parse(screen("generating", "wide"), { agent: "omp", omoAsk: null, omoTrusted: true, omoOpen: [], sent: null, working: false })?.responder).toBe("omp-handoff");
  });

  it("keeps one card while the spinner turns", () => {
    const shown = screen("generating", "wide");
    const turned = shown.replace("⠙ Generating", "⠹ Generating");
    expect(turned).not.toBe(shown);
    expect(parseInteractivePrompt("omp", turned)).not.toBeNull();
    expect(parseInteractivePrompt("omp", turned)?.id).toBe(parseInteractivePrompt("omp", shown)?.id);
  });

  it("shows no card before, after or without a handoff being written", () => {
    for (const width of widths) {
      for (const step of ["empty", "cancelled", "done"]) expect(parseInteractivePrompt("omp", screen(step, width)), `${step} ${width}`).toBeNull();
    }
  });

  it("ignores the status line once anything but omp's status bar and editor follows it", () => {
    const shown = screen("generating", "wide");
    const moved = shown.replace(/(Generating handoff… \(⎋ to cancel\)\n)/, "$1 Fixture answer for the handoff recording.\n");
    expect(moved).not.toBe(shown);
    expect(parseInteractivePrompt("omp", moved)).toBeNull();
  });
});
