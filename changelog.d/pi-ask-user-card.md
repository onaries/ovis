### Added
- The `ask_user` form of the `@eko24ive/pi-ask` pi package shows as a chat card and is answered
  from the chat, one question per step, once the web UI's pi extension is installed with
  `bun scripts/install-pi-integration.ts`. The answer goes to pi-ask through its own events,
  never as typed keys; without the extension the form stays in Terminal (#1202). Reported by
  @chobijaeyu.
