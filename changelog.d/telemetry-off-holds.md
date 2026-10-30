### Fixed
- Turning anonymous usage counts off now holds when two Ovis servers of this version or later share
  one state folder (an installed app and a source checkout, say): the other server recording a visit
  or a count at that moment could turn them back on, and the next day's message would go out.
