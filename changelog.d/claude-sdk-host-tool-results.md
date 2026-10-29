### Fixed
- Chat no longer shows an OmO tool's output as a big message from you when OmO runs Claude Code
  through its SDK (a `Tool result (mcp__custom-tools__eval, id=…):` bubble between work blocks).
  The output now folds into the work block as that call's result, and the call no longer counts as
  failed while OmO runs it. A message you sent along while the tools ran still shows as yours.
