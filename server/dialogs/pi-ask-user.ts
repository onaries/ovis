import type { DialogReader } from "./registry.ts";

/**
 * @eko24ive/pi-ask's ask_user form is read from the web UI's pi extension and answered through
 * pi-ask's own submit event (server/pi-ask-bridge.ts), never from the screen. Registered so that a
 * Chat send's outcome knows the card it opened.
 */
export const readers: readonly DialogReader[] = [{
  id: "pi-ask-user",
  agents: ["pi"],
  priority: 85,
  parse: () => null,
  // the last step re-reads the extension before it submits (answerPiAskUser)
  reread: "before-commit",
  list: "none",
}];
