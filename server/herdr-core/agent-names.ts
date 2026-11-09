import { isAgentName } from "../../shared/agent-name.ts";
import { catalogPlatform } from "../../shared/agent-catalog.ts";
import { processAgent } from "../agent-identity.ts";
import { processStartIdentity } from "../process-start.ts";
import { HcError, type HcConnection } from "./connection.ts";
import { agentOf, isRecord, onOtherMachine, type HcTerminal } from "./snapshot.ts";

export const AGENT_NAMES_DOC = "ovis.agent-names";

export class AgentNameError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

interface Binding {
  terminal: string;
  created: number;
  pid: number;
  start: number;
  agent: string;
  name: string;
}

export interface AgentCallName { name: string; owner: string; ready: boolean }

function ownerOf(entry: Omit<Binding, "name">): string {
  return JSON.stringify([entry.terminal, entry.created, entry.pid, entry.start, entry.agent]);
}

function bindings(value: unknown): Binding[] {
  if (!isRecord(value) || value["schema"] !== 1 || !Array.isArray(value["bindings"])) return [];
  return value["bindings"].filter((entry): entry is Binding => isRecord(entry)
    && typeof entry["terminal"] === "string" && typeof entry["created"] === "number"
    && Number.isSafeInteger(entry["pid"]) && Number(entry["pid"]) > 0
    && typeof entry["start"] === "number" && typeof entry["agent"] === "string"
    && typeof entry["name"] === "string" && isAgentName(entry["name"]));
}

/** Core has no agent names: the compatibility socket shares a versioned document across Ovis clients. */
export class AgentNames {
  constructor(private readonly hc: HcConnection, private readonly local: boolean) {}

  private current(entry: Binding, terminal: HcTerminal): boolean {
    if (!this.local || onOtherMachine(terminal.address) || terminal.state !== "live"
      || terminal.address !== entry.terminal || terminal.created_ms !== entry.created
      || processStartIdentity(entry.pid) !== entry.start) return false;
    const front = terminal.foreground;
    const agent = front ? processAgent(front.argv?.length ? front.argv : [front.name], catalogPlatform(process.platform)) : null;
    // A suspended agent retains its name, but another agent in the same terminal never inherits it.
    return (front?.pid === entry.pid ? agent === entry.agent : !agent)
      && (agentOf(terminal, catalogPlatform(process.platform)) === null || agentOf(terminal, catalogPlatform(process.platform)) === entry.agent);
  }

  private live(value: unknown, terminals: readonly HcTerminal[]): Binding[] {
    const live = bindings(value).filter((entry) => terminals.some((terminal) => this.current(entry, terminal)));
    // An ambiguous document must never route a prompt to an arbitrary terminal.
    return live.filter((entry) => live.filter((other) => other.name === entry.name).length === 1
      && live.filter((other) => other.terminal === entry.terminal).length === 1);
  }

  async names(terminals: readonly HcTerminal[]): Promise<ReadonlyMap<string, AgentCallName>> {
    if (!this.local) return new Map();
    const doc = await this.hc.call("doc.get", { name: AGENT_NAMES_DOC });
    return new Map(this.live(doc.value, terminals).map((entry) => [entry.terminal, {
      name: entry.name, owner: ownerOf(entry), ready: terminals.find((terminal) => terminal.address === entry.terminal)?.foreground?.pid === entry.pid,
    }]));
  }

  async rename(address: string, name: unknown): Promise<void> {
    if (name !== null && (typeof name !== "string" || !isAgentName(name))) {
      throw new AgentNameError("invalid_agent_name", "name must match [a-z][a-z0-9_-]{0,31}, or be null");
    }
    if (!this.local || !(await this.hc.hello()).methods.includes("doc.set")) {
      throw new AgentNameError("unsupported", "agent call names require a local herdr-core with writable documents");
    }
    let expectedOwner: string | undefined;
    for (let attempt = 0; ; attempt++) {
      const doc = await this.hc.call("doc.get", { name: AGENT_NAMES_DOC });
      if (doc.value != null && (!isRecord(doc.value) || doc.value["schema"] !== 1 || !Array.isArray(doc.value["bindings"]))) {
        throw new AgentNameError("unsupported", "this core's agent names use an unknown document format");
      }
      const { terminals } = await this.hc.call("terminal.list", {});
      const terminal = terminals.find((entry) => entry.address === address && entry.state === "live");
      if (!terminal || onOtherMachine(address) || !agentOf(terminal, catalogPlatform(process.platform))) {
        throw new AgentNameError("agent_not_found", `no agent in terminal ${address}`);
      }
      const live = this.live(doc.value, terminals);
      const next = live.filter((entry) => entry.terminal !== address);
      const front = terminal.foreground;
      const agent = front ? processAgent(front.argv?.length ? front.argv : [front.name], catalogPlatform(process.platform)) : null;
      const start = front ? processStartIdentity(front.pid) : null;
      if (!front || !agent || agent !== agentOf(terminal, catalogPlatform(process.platform)) || start === null || !Number.isFinite(terminal.created_ms)) {
        throw new AgentNameError("agent_not_ready", "the agent process is not identifiable; retry while its terminal is active");
      }
      const owner = { terminal: address, created: terminal.created_ms, pid: front.pid, start, agent };
      if (expectedOwner !== undefined && ownerOf(owner) !== expectedOwner) {
        throw new AgentNameError("agent_not_found", "the agent changed while its call name was being saved");
      }
      expectedOwner = ownerOf(owner);
      if (name !== null) {
        if (next.some((entry) => entry.name === name) || terminals.some((entry) => entry.address === name)) {
          throw new AgentNameError("agent_name_taken", `agent name ${name} is already in use or names a terminal`);
        }
        next.push({ ...owner, name });
      }
      try {
        await this.hc.call("doc.set", { name: AGENT_NAMES_DOC, value: { schema: 1, bindings: next }, version: doc.version });
        return;
      } catch (error) {
        if (error instanceof HcError && error.kind === "conflict" && attempt < 2) continue;
        throw error;
      }
    }
  }
}
