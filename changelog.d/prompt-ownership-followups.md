### Fixed
- An OmO question answered from a Chat card no longer goes to another open question when the
  pane is too small to show the form's title: when the form left in view fits more than one open
  question, the card is refused and nothing is sent.
- A Claude command sent from Chat beside the fullscreen diff panel no longer takes the question of
  the same command typed in the terminal after an earlier send's echoes were counted without the
  panel.
- A command sent to an OmO pane with two OmO processes holding sessions keeps its outcome on the
  OmO it was sent to, also when it waited in the queue and herdr listed the other one first by
  then, and never on a later process that got the OmO's process number.
