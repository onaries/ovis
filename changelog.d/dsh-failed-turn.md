### Fixed
- A DeepSeek Harness (dsh-tui) turn that ends in a provider error (no balance, a rate limit) now shows
  dsh's own error under the message in Chat as a failed request, instead of a "Background result
  delivered" divider; a turn stopped by the user reads "Turn ended: aborted".
