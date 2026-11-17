/** Run the shared native-queue browser contract with Codex's Tab delivery. */
export {};
process.argv[2] = "codex";
await import("./omo-queue-browser-qa.ts");
