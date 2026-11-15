// The agent inbox mode's addresses of gone panes, its ways in, its column at every width and its rail: a part of
// scripts/inbox-mode-demo-regression.ts, run on its own so each part fits the browser lane's limit for one script.
process.env["INBOX_MODE_PART"] = "rail";
// set before the script loads, so the import is dynamic
await import("./inbox-mode-demo-regression.ts");
export {};
