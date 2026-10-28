### Fixed
- Codex Chat names literal command objects passed unchanged through Promise.all or
  Promise.allSettled instead of showing only exec.
- Dynamically generated commands and patches show their nested tool names when the exact
  command or edited files cannot be established without executing the script.
