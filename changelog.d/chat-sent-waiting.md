### Changed
- A message sent from Chat shows at once as your own bubble, faded, until the agent writes it as a
  turn, so the chat is never blank between Send and the agent's turn. A small clock joins it only
  when the agent has not taken it after 5 seconds. A command (`/cost`, `! ls`) gets no bubble, since
  it never comes back as that message, and a bubble whose turn has not come within a minute goes.
