### Fixed
- Add a connection → SSH matches a config host to the Tailscale PC its name actually resolves to
  (hosts file, DNS or MagicDNS, waiting 1.5 s at most), so a host that only shares a PC's name no
  longer hides that PC, and two spellings of the same IPv6 address now match. A host also takes
  the HostName ssh would use, including one set under a later `Host *` block.
