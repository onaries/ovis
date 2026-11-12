### Added
- `/api/health` tells every caller that gets its full answer (the callers that also see `security`:
  the token, a paired device, the owner's Tailscale or a Portal sign-in, this PC itself while no
  token is set, and anyone on the network while the install is still open with no token and nothing
  paired) the version of the Ovis server it reached (`version`), also when that server runs as the
  compiled server binary.
