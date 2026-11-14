#!/usr/bin/env bun
/** Local Ovis call names, without changing hc or bypassing its agent-owner checks. */
import { herdrRpc } from "../server/herdr/client.ts";
import { adapterAddress } from "../server/herdr-core/pipe.ts";
import { defaultStateDir } from "../server/update-state.ts";

const [command, target, ...words] = process.argv.slice(2);
const socket = process.env["OVIS_AGENT_SOCKET"] ?? adapterAddress(defaultStateDir());
try {
  if (command === "list" && target === undefined) {
    console.log(JSON.stringify(await herdrRpc("agent.list", {}, socket), null, 2));
  } else if (command === "get" && target !== undefined && words.length === 0) {
    console.log(JSON.stringify(await herdrRpc("agent.get", { target }, socket), null, 2));
  } else if (command === "send" && target !== undefined && words.length > 0) {
    console.log(JSON.stringify(await herdrRpc("agent.prompt", { target, text: words.join(" ") }, socket, 60_000)));
  } else {
    console.error("Usage: ovis-agent list | get <call-name> | send <call-name> <text>");
    process.exitCode = 2;
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
