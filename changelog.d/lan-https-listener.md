### Added
- An opt-in HTTPS listener for devices on the same network: `OVIS_LAN_HTTPS_PORT` opens one on the
  PC's private addresses with a self-signed certificate (or your own via `OVIS_LAN_HTTPS_CERT` and
  `OVIS_LAN_HTTPS_KEY`), which lets in only the token or a paired device. Off unless set.
