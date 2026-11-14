### Added
- Agents list, grouped by state: a group folds from its heading, which keeps its count. The folds
  are kept on the device, Idle starts folded, the selected agent stays in sight under a folded
  group, and the filter opens every group.
- Every agent row says how long its agent has been in its state (`<1m`, `5m`, `2h`, `3d`). The
  device notes each change it sees, and keeps a time across reloads while herdr's own change
  counter and Ovis's count of the agent's finished turns show that nothing changed meanwhile;
  reading a finished agent does not reset its time, and a state the device did not see begin, one
  that changed while it slept included, shows no time.

### Changed
- Agents list, grouped by state: a heading says its state once, in the state's colour with the
  count beside it, and the rows under it no longer repeat the state mark.
- Agents list, grouped or not: a row leaves out what would be cut to a few letters after its
  title, a waiting agent's reason and, on One line, its place. On a phone a One line row is one
  line: the title, then the time, with no place. Two lines keeps the place on its second line,
  where the time now ends the line.
- An agent row's menu says first what a waiting agent waits for, on a line of its own, in a phone's
  sheet and in the menu of a wider screen.
