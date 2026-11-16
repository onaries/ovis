// Sign out on a server with a token, and the relay panel: a part of scripts/ui-regression.ts, run on its own so each
// part fits the browser lane's limit for one script, and on a herdr session of its own so it shares none with a part
// beside it.
import { runOnOwnHerdr } from "./own-herdr.ts";

await runOnOwnHerdr("ui-regression's access part", async () => {
  // read by scripts/ui-regression.ts when it is imported; run itself, it is always main
  process.env["UI_REGRESSION_PART"] = "access";
  await import("./ui-regression.ts");
});
