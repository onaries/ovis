### Fixed
- A chat message is no longer typed into Codex's transcript prompt browser (Esc in the transcript
  pager Ctrl+T opens with `[tui] fullscreen_transcript = false`), where its letters moved through
  the earlier prompts and its Enter rewound the conversation to the prompt picked, at any pane width
  where Codex draws that browser's footer.
