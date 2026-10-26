### Fixed
- A message queued in Chat for an agent started through a launcher that stays in front of it (an
  npm `claude` wrapper, a shell script) is held when the agent behind the launcher restarts, as it
  is for an agent started directly, instead of going to the new agent.
- On macOS, checking which agent a queued or first message goes to no longer stops the server
  while `ps` answers.
