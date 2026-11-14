### Fixed
- A chat send refused over Claude Code's input box no longer offers Send anyway while the box holds
  a paste or an image Claude folded into a placeholder (`[Pasted text #1 +12 lines]`, `[Image #1]`):
  the folded lines were hidden, and sending anyway typed the message behind them and sent both. A
  Send anyway confirmed after such a placeholder came into the box is refused too.
