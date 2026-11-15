// The agent inbox mode with panes, terminals, the focus, rows and a lost connection: a part of
// scripts/inbox-mode-demo-regression.ts, run on its own so each part fits the browser lane's limit for one script.
process.env["INBOX_MODE_PART"] = "panes";
// set before the script loads, so the import is dynamic
await import("./inbox-mode-demo-regression.ts");
export {};
