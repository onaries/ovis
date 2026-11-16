### Fixed
- A message sent from Chat that the agent never records (it failed the turn before writing it: a
  sign-in lapsed, a model gone) no longer vanishes after a minute. Once the agent is at rest, it stays
  under the conversation as "Not in the conversation", with Open Terminal, where the agent's error is,
  and a Dismiss button; a reload of the tab keeps it.
- A sent message waiting for a working agent to take it now keeps its bubble for up to ten minutes,
  not one, before it goes.
