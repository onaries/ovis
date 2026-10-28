### Fixed
- A push endpoint its push service retired stays refused, however long ago that was, until its
  owner's device is revoked or a thousand later retirements push its mark out. Before, after 30 days
  another device that knew the endpoint could register it as its own, and so could another spelling
  of it (a `#fragment`, an uppercase host or `:443`) at any time.
- A subscription its push service retired is removed even when `push-retired.json` cannot be
  written (a full disk, a read-only state directory). Before, the failed write left it registered
  and the next alert went to the dead endpoint again.
