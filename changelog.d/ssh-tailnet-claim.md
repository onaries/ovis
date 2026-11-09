### Fixed
- Add a connection → SSH no longer hides a PC of your Tailscale login behind an ssh config host that only shares its
  name: a config host stands for a Tailscale PC only when its HostName reaches that PC (its machine name, MagicDNS
  name or Tailscale address), so an alias kept from before a rename no longer takes the place of the PC it once named.
