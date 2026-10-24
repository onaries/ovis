### Fixed
- Chat's command menu, and the terminal handoff of a command that needs the terminal, come back on
  their own after the pane's command list failed to load (a dropped connection, a restarting
  bridge), instead of staying empty until the pane is opened again.
- pi: `/name Release 1`, `/model <id>` and pi's other commands given an argument are no longer taken
  for terminal screens.
- An omo pane is typed into as omo even when an omo-looking helper process is listed before the omo
  that holds the session.
- OpenCode v2: the builtins both TUIs share are shown as verified on a v2 pane, as on v1.
- Claude Code: a bundled skill run by its slash command (`/code-review`, `/simplify`...), or a skill
  of your own named like one, shows as skill activity.
