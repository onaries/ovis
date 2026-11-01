### Fixed
- On Linux without `secret-tool`, Settings → Agents no longer calls a signed-in Antigravity CLI
  "Not signed in": it says the sign-in cannot be read until `secret-tool` (libsecret-tools) is
  installed, and finds the account on the next look once it is.
