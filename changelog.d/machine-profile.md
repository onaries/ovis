### Added
- A machine profile, as a preview: `OVIS_PROFILE=machine` beside `OVIS_PREVIEW=fleet` starts
  `ovis-server serve` next to an existing classic herdr, on loopback only, with its own relay
  identity and a state folder of its own (`OVIS_STATE_DIR`). Its pairing gate is closed from the
  first start, a Tailscale identity header lets nobody in, and engine updates, runtime changes,
  Portal, LAN HTTPS and direct connections are unavailable in it. Its TCP port answers only that it
  is alive, and `OVIS_TOKEN` is ignored there; its owner reaches it on the unix socket `serve.sock`
  in its state folder, which only that account can open. A forwarder the owner puts in front of
  that socket is the owner's own exposure: its clients are taken for the owner. It does not start
  on Windows. Without `OVIS_PREVIEW=fleet` it says what to set and exits before it touches its
  state folder. A profile starts only on a state folder that is empty or that it marked itself
  (`machine-profile.json`), not on one another server wrote to before it. An ordinary server
  started with `OVIS_PREVIEW=fleet` holds a lock file `serve.own` in its state folder (not on
  Windows) and does not start on a folder a running profile holds; without the preview it takes no
  lock. The machine profile stays a preview.

### Changed
- `ovis-server` does not start on a state folder that holds a machine profile's marker
  (`machine-profile.json`): it names the folder, says to give it another `OVIS_STATE_DIR`, and
  exits. A machine profile writes that marker into the folder it is started on.
