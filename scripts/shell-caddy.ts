import { shellCaddyfile } from "./shell-build.ts";

const [site, root] = process.argv.slice(2);
if (!site) throw new Error("Usage: bun scripts/shell-caddy.ts <site address> [root folder]");
process.stdout.write(shellCaddyfile(site, root));
