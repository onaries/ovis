### Fixed
- A message that went to the terminal no longer stays "Not confirmed" when the connection dropped
  before its receipt arrived: the browser that sent it gets the receipt back when it reconnects or
  reloads, within ten minutes. Nothing is sent again, and a message whose delivery was never
  confirmed stays unconfirmed.
