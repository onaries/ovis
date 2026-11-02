### Fixed
- Codex Chat measures completed reply evidence in UTF-8 bytes so substantial Korean text is not
  rejected by an English-sized character minimum. This includes plain replies whose prompts
  scrolled away and text after rendered tables.
- Native queued follow-ups below a completed-turn footer no longer hide its conversation.
  Ambiguous replies, short fragments and tool output still cannot select a conversation.
- Substantial progress paragraphs with rendered inline code or emphasis can identify a
  working Codex conversation without relaxing the minimum for unfinished replies.
- Background plan reads no longer remember a display match as a conversation binding.
