### Fixed
- In chat, Send now on a Grok pane sends the message at once when Grok queued it behind a turn at work and
  Grok's screen shows it as the only row of a queue that was empty before it: one more Enter on Grok's empty
  prompt, which ends the turn at work. This holds also when another client started that turn just before the
  send. When rows were queued in Grok before or after it, Grok's prompt holds typed text, or Grok runs in
  minimal mode, nothing more is pressed: the message stays queued in Grok, and its row says so and offers no
  second Send now. When Grok's screen does not show where the message went (an approval card, no queued row, a
  failed read), nothing more is pressed and the row asks you to check the terminal. A plain Send to a working
  Grok still queues behind the turn.
