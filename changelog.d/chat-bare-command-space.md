### Fixed
- An OpenCode built-in picked from Chat's `/` menu and sent as it is (`/new`) now runs, instead of
  being sent as a prompt because of the space the menu adds after it. OpenCode's own and plugin
  commands, its built-ins that take an argument, every other agent's commands and anything typed by
  hand still go exactly as written.
