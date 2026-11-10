### Changed
- app.ovis.sh now opens on a sign-in screen, with pairing by QR code or code and PCs paired
  without an account one link away.
- The hosted relay app is now a compact console: a sidebar (a bottom tab bar on a phone) with
  Overview, PCs, Devices, Relay and Settings, each a link of its own that Back returns from.

### Added
- The Overview counts your PCs as Ready or Needs you (with how many are offline), lists at most
  three that need you with what each needs, and shows your PCs in a dense table you can filter.
- Each paired PC shows how this device reaches it right now (same network, Tailscale or relay)
  with its measured round trip, and the Overview summarizes how many PCs are reachable now.
- A PC's details open beside the table without connecting to it, and a never-seen PC says so
  instead of showing a made-up time.
- The connection map moved to Relay: a diagram for up to eight PCs on a wide screen, a list of
  relays and PCs otherwise. A wire moves only while this device checks the PC.
- Adding or joining a PC is a sheet that starts pairing on the first confirmation, says which of
  four steps it is on, waits for the approval with its time limit, stops at Ready until you open
  the PC, and renews the connection before reading account introductions.
