### Fixed
- Adding a PC whose own Ovis listens on another address than 127.0.0.1 (its HOST set to, say, its
  Tailscale address) connects instead of failing with "ECONNRESET": that Ovis now also answers the
  app's SSH tunnel on the PC's 127.0.0.1. An older Ovis set up that way, or one whose HOST is a host
  name, gets an error saying to update it or set HOST=127.0.0.1 there.
