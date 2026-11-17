/**
 * herdr's rule for an agent's live name (`herdr agent rename`, RPC agent.rename): a lowercase
 * letter, then up to 31 lowercase letters, digits, `-` or `_`, unique among the live agents of
 * the session and gone when the agent exits.
 */
export const AGENT_NAME_MAX_LENGTH = 32;

export const AGENT_NAME_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/;

export function isAgentName(value: string): boolean {
  return AGENT_NAME_PATTERN.test(value);
}
