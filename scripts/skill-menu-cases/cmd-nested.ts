import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { paneCommands } from "../../server/commands.ts";
import type { SlashCommand } from "../../shared/protocol.ts";
import type { CaseRun } from "../skill-menu-case.ts";

export const agent = "cmd";
const tree = mkdtempSync(join(tmpdir(), "cmd-nested-menu-"));
export const commands: SlashCommand[] = (() => {
  try {
    const repo = join(tree, "repo");
    const cwd = join(repo, "src", "nested");
    const commandDir = join(repo, ".commandcode", "commands", "frontend");
    mkdirSync(cwd, { recursive: true });
    mkdirSync(join(repo, ".git"));
    mkdirSync(commandDir, { recursive: true });
    writeFileSync(join(commandDir, "component.md"), "Build a component");
    return paneCommands(agent, cwd, join(tree, "home"));
  } finally { rmSync(tree, { recursive: true, force: true }); }
})();
export const turnText = "The component is ready.";
export const chips: string[] = [];
export const widths = [1280, 390] as const;
export const schemes = ["dark", "light"] as const;

export const expect = async ({ box, menu, scenario, width, scheme, menuFits, rowsBrief }: CaseRun): Promise<void> => {
  await scenario(`nested command label at ${width}px ${scheme}`, `nested-${width}-${scheme}.png`, async (capture) => {
    await box.fill("/comp");
    const row = menu.locator(".menu-item").filter({ hasText: "component" });
    await row.waitFor();
    if (await row.locator(".menu-item-main").textContent() !== "/component") throw new Error("nested command name includes its folder or trigger");
    if (await row.locator(".menu-item-hint").textContent() !== "Project · frontend · Build a component") throw new Error("nested folder label or command description is missing");
    await menuFits("nested command");
    await rowsBrief("nested command");
    await capture();
  });
  for (const text of ["/mode:", "/mode:pl"]) {
    await scenario(`mode completion ${text} at ${width}px ${scheme}`, `mode-${text.length}-${width}-${scheme}.png`, async (capture) => {
      await box.fill(text);
      const row = menu.locator(".menu-item-main").filter({ hasText: /^\/mode:plan$/ });
      await row.waitFor();
      await menuFits("mode completion");
      await capture();
    });
  }
};
