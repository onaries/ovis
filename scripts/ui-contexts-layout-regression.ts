// The two slowest UI context checks (split view, a background tab's terminal size), apart from
// ui-contexts-regression.ts so that neither script comes near the browser lane's per-script cap.
import { runIsolatedUiContextChecks } from "./ui-contexts-run.ts";

await runIsolatedUiContextChecks("layout");
