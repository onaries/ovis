### Fixed
- A message sent to a PC whose Ovis is too old to confirm messages is no longer treated as delivered:
  the composer, Send now on a held copy and the held queue's Send now keep its text as a
  "Not confirmed" row to copy or discard, instead of dropping it.
- A terminal command sent from Chat right after a pane opens now opens the terminal view even when
  the terminal had not loaded the pane's command list yet, and a chat shown again draws its
  "Ran in terminal" rows at once instead of as plain messages first.
