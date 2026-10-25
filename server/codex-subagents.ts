import type { CodexSubagentCall, ConversationPart } from "../shared/protocol.ts";
import { execToolCalls } from "../shared/execSummary.ts";

const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const string = (value: unknown): string => typeof value === "string" ? value : "";
const OPERATIONS = { spawn_agent: "spawn", wait_agent: "wait", send_input: "send", close_agent: "close", resume_agent: "resume", send_message: "send", interrupt_agent: "interrupt", followup_task: "followup" } as const;

function operation(name: string): CodexSubagentCall["operation"] | null {
  const key = name.replace(/^multi_agent_v[12](?:__|\.)/, "");
  return Object.hasOwn(OPERATIONS, key) ? OPERATIONS[key as keyof typeof OPERATIONS] : null;
}

// shortcut: code-mode fields require JSON literals; extend this if emitted calls use other forms.
function staticArguments(input: string): Record<string, unknown> {
  let rest = input.trimStart();
  if (!rest.startsWith("{")) return {};
  rest = rest.slice(1);
  const fields: Record<string, unknown> = {};
  const field = /^\s*(?:([A-Za-z_$][\w$]*)|"([^"\\]+)")\s*:\s*("(?:[^"\\]|\\.)*"|true|false|null|-?\d+(?:\.\d+)?|\[\s*(?:"(?:[^"\\]|\\.)*"\s*,?\s*)*\])(?=\s*[,}])/;
  for (let count = 0; count < 32; count++) {
    const match = field.exec(rest);
    if (!match) break;
    const key = match[1] ?? match[2];
    if (key === undefined || match[3] === undefined) break;
    try { fields[key] = JSON.parse(match[3]); } catch (error) { if (!(error instanceof SyntaxError)) throw error; break; }
    rest = rest.slice(match[0].length).trimStart();
    if (!rest.startsWith(",")) break;
    rest = rest.slice(1);
  }
  return fields;
}

function replies(output: unknown): Record<string, unknown>[] {
  if (typeof output !== "string") return Array.isArray(output) ? output.map(record) : [record(output)];
  const text = output.slice(0, 262144);
  const candidates = [text, text.split(/\nOutput:\s*\n/).at(-1) ?? "", ...text.split("\n")];
  const found = new Map<string, Record<string, unknown>>();
  for (const text of candidates) {
    if (!/^[\s]*[\[{]/.test(text)) continue;
    try {
      const parsed: unknown = JSON.parse(text);
      for (const value of Array.isArray(parsed) ? parsed : [parsed]) {
        const row = record(value);
        found.set(JSON.stringify(row), row);
      }
    } catch (error) { if (!(error instanceof SyntaxError)) throw error; }
    if (found.size >= 64) break;
  }
  return [...found.values()];
}

function status(value: unknown): CodexSubagentCall["status"] {
  if (value === "pending_init" || value === "running" || value === "completed" || value === "errored" || value === "interrupted" || value === "shutdown" || value === "not_found") return value;
  const row = record(value);
  if (Object.hasOwn(row, "completed") && (typeof row.completed === "string" || row.completed === null)) return "completed";
  if (Object.hasOwn(row, "errored") && (typeof row.errored === "string" || row.errored === null)) return "errored";
  return null;
}

export function codexSubagentCalls(name: string, input: string, output: unknown = ""): CodexSubagentCall[] {
  let args: Record<string, unknown> = {};
  try { args = record(JSON.parse(input)); } catch (error) { if (!(error instanceof SyntaxError)) throw error; }
  const direct = operation(name);
  const calls = direct === null
    ? name === "exec" ? execToolCalls(input).flatMap((call) => {
      const kind = operation(call.name);
      return kind === null ? [] : [{ kind, args: staticArguments(input.slice(call.argumentsAt)) }];
    }) : []
    : [{ kind: direct, args }];
  if (calls.length === 0) return [];
  const answers = replies(output);
  const spawned = answers.filter((row) => string(row.agent_id).length > 0);
  const states = new Map<string, unknown>();
  for (const answer of answers) for (const [id, value] of Object.entries(record(answer.status)).slice(0, 64)) if (id.length <= 256) states.set(id, value);
  const oneSpawn = calls.filter((call) => call.kind === "spawn").length === 1 && spawned.length === 1 ? spawned[0] : undefined;
  return calls.flatMap((call): CodexSubagentCall[] => {
    const prompt = (string(call.args.message) || string(call.args.prompt)).slice(0, 20000);
    const title = (string(call.args.task_name) || prompt.split("\n")[0]?.replace(/^TASK:\s*/, "") || "").slice(0, 120);
    const id = string(call.args.agent_id) || string(call.args.id) || string(call.args.target);
    const targets = Array.isArray(call.args.targets) ? call.args.targets : Array.isArray(call.args.ids) ? call.args.ids : [];
    const ids = call.kind === "wait" ? [...new Set([...targets.filter((value): value is string => typeof value === "string" && value.length <= 256), ...states.keys()])].slice(0, 64) : [id.slice(0, 256) || null];
    return (ids.length > 0 ? ids : [null]).map((agentId) => ({
      operation: call.kind, title, prompt, agent_type: string(call.args.agent_type).slice(0, 120) || null,
      agent_id: call.kind === "spawn" ? string(oneSpawn?.agent_id).slice(0, 256) || null : agentId,
      nickname: call.kind === "spawn" ? string(oneSpawn?.nickname).slice(0, 120) || null : null,
      status: call.kind === "wait" && agentId !== null ? status(states.get(agentId)) : null,
    }));
  }).slice(0, 64);
}

export function codexSubagentNotification(text: string, known: readonly CodexSubagentCall[]): ConversationPart | null {
  const match = /^<subagent_notification>\s*([\s\S]*?)\s*<\/subagent_notification>$/.exec(text.trim());
  if (!match || match[1] === undefined) return null;
  let notice: Record<string, unknown> = {};
  try { notice = record(JSON.parse(match[1])); } catch (error) { if (!(error instanceof SyntaxError)) throw error; }
  const id = (string(notice.agent_path) || string(notice.agent_id)).slice(0, 256);
  const state = record(notice.status);
  const kind = status(state);
  if (id && (kind === "completed" || kind === "errored")) {
    const matching = known.filter((call) => call.agent_id === id).reverse();
    const call = matching.find((call) => call.title.length > 0);
    const agent = matching.find((call) => call.agent_type !== null)?.agent_type ?? null;
    const result = string(kind === "completed" ? state.completed : state.errored);
    return { kind: "task_result", tasks: [{ id, title: call?.title || string(notice.agent_nickname) || id, agent, model: null,
      status: kind === "completed" ? "completed" : "failed", duration_ms: null, turns: null, tool_calls: null, tokens: null,
      result: result.slice(0, 16000), ...(result.length > 16000 ? { result_cut: true } : {}),
    }] };
  }
  return { kind: "notice", source: "codex-subagent", text: match[1] };
}
