// The UI context checks but the two slowest, which ui-contexts-layout-regression.ts runs.
import { runIsolatedUiContextChecks } from "./ui-contexts-run.ts";

await runIsolatedUiContextChecks("main");
