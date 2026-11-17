### Maintenance
- Self-hosted CI runner: each slot's docker network is now a /28 of the block `10.213.0.0/16`,
  never a range docker picks, and none is removed or made while the kernel has no route to the
  internet. A network docker gave 192.168.0.0/20 at boot, before the LAN's route was up, put its
  bridge on the LAN router's address and took the host offline. A /28 is skipped when a route
  (/8 or narrower; a broader one counts as a default) or an address of the host overlaps it, or
  when docker refuses it; `OVIS_CI_NETWORK_BLOCK` names another block, inside 10.0.0.0/8 or
  172.16.0.0/16. A slot's network that is not a /28 of the block is made again before the slot's
  next container, and left alone while a container is on it. Limits: a kept network is not checked
  again, so a host that later joins a network inside the block needs another block; a host that
  routes all of both 10.0.0.0/8 and 172.16.0.0/16, or has no IPv4 route to the internet (IPv6 or
  a proxy only), or no `ip`, starts no runner and says so. Every launcher on a runner host must be
  replaced by the new `run.sh`, each installed copy keeping its own `PREFIX` line, and restarted.
