/**
 * herdr's rule for an agent's live name (`herdr agent rename`, RPC agent.rename): a lowercase
 * letter, then up to 31 lowercase letters, digits, `-` or `_`, unique among the live agents of
 * the session and gone when the agent exits. The dialog checks it as the name is typed and the
 * demo answers with it; the server leaves the rule to herdr, whose refusal (`invalid_agent_name`,
 * `agent_name_taken`) is shown as it comes. Kept apart from protocol.ts so the browser can
 * import the value (that module reads the environment at load).
 */
export const AGENT_NAME_MAX_LENGTH = 32;

export const AGENT_NAME_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/;

export function isAgentName(value: string): boolean {
  return AGENT_NAME_PATTERN.test(value);
}
