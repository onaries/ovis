import { runOnOwnHerdr } from "./own-herdr.ts";
import type { UiContextGroup } from "./ui-contexts-checks.ts";

/**
 * Runs one group of the UI context checks on a herdr session, config and fixture of its own, and
 * stops that session after. Each group is a browser script of its own (ui-contexts-regression.ts,
 * ui-contexts-layout-regression.ts), so none comes near the browser lane's per-script cap.
 */
export async function runIsolatedUiContextChecks(group: UiContextGroup): Promise<void> {
  await runOnOwnHerdr("UI context checks", async () => {
    const { runUiContextChecks } = await import("./ui-contexts-checks.ts");
    await runUiContextChecks(group);
  });
}
