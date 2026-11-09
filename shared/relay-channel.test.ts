import { expect, it } from "bun:test";
import { orderDirectRoutes } from "./relay-channel.ts";

const lan = "ws://192.168.1.20:7319";
const lan2 = "ws://10.0.0.5:7319";
const tailnet = "ws://100.101.102.103:7319";

it.each([
  ["same-network addresses before Tailscale ones, whatever order the PC named them in", [tailnet, lan, lan2], undefined, [lan, lan2, tailnet]],
  ["the carrier that worked last first among its kind", [lan, lan2, tailnet], lan2, [lan2, lan, tailnet]],
  ["a Tailscale carrier that worked last still after the same network's", [lan, tailnet], tailnet, [lan, tailnet]],
] as const)("orders direct routes: %s", (_name, carriers, worked, expected) => {
  expect(orderDirectRoutes(carriers, worked)).toEqual([...expected]);
});
