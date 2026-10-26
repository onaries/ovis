### Added
- An OpenCode 2 pane's subagents are background tasks, as a Claude Code pane's are: the message
  box's button and the sidebar badge count those running, the list shows them with the newest ten
  that ended in the last day, a turn that ends while they run reads BG with its finish alerted
  once, and one whose pane no longer runs that session reads as lost. A subagent run in the
  background leaves a card in the chat with its answer, and a foreground one's answer no longer
  shows OpenCode's `<subagent>` tag.
