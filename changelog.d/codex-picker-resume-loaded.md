### Fixed
- Codex Chat now opens a session resumed through the `codex resume` picker from another folder on
  Linux and macOS, with Codex's default terminal title. Codex keeps every conversation a TUI shows
  loaded and locked; when nothing of the pane's own folder matches, the chat looks among those and
  shows one while the pane's screen shows one of its longer answers that no other open conversation
  ever said. Only Codex's answers on screen count, never a prompt, an answer to one of its
  questions, a queued message, a tool's output, the status line, the input box or the picker's
  list. It is not remembered: once the screen no longer shows such an answer, the chat says it
  cannot tell, as it does while another open Codex conversation is answering, or was interrupted
  or failed since it was opened. On Windows the `"thread-id"` title item is still needed.
