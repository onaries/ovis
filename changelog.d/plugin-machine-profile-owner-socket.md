### Changed
- Under the fleet preview, with `OVIS_PROFILE=machine` (both in the environment or in the plugin's
  settings file, as the server it starts reads them), the plugin reaches a machine profile through
  its owner socket, `serve.sock` in its state folder, which the profile records there
  (`serve.lock/http.json`), as `http://localhost` and with no token, instead of its TCP port, which
  answers liveness only. Its health check (as `status`, `start`, `phone`, `phone-setup`, `pair` and
  `add` make it) and the requests of `add` (also `link` and `login`), `pair` (also `--approve`) and
  `phone-setup` go there, and a command keeps the door its health check passed on for all its
  requests. The plugin takes the socket only when the state folder passes the profile's own check
  and `serve.sock` is a socket this account owns, and reads the record only as a regular file of
  at most 4 KiB. A profile whose herdr does not answer counts as running, and `status` adds
  `engine: down` with the profile's reason. With both, the server counts as running only when it
  answers on that socket: without a readable record that names it (`door: 1`), or a socket the
  plugin takes, it is not running and the plugin sends it nothing. `start` does not start a machine
  profile: with none answering on that socket it spawns nothing, says how one is started
  (`OVIS_PROFILE=machine`, `OVIS_PREVIEW=fleet` and a state folder of its own for `ovis-server serve`)
  and exits 1. `pair` starts no pairing for a profile, and `phone` and `phone-setup` show no address
  and change nothing of Tailscale: each says that a phone reaches the profile through the Ovis relay
  only, with `ovis add` or `ovis link --code`. Without the preview or without
  `OVIS_PROFILE=machine`, the plugin uses the TCP port as before.
