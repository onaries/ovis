### Fixed
- Ovis for Mac takes the installer only over HTTPS from ovis.sh or herdrweb.dev, reads the phone
  address only from this Mac's own server, and draws the QR code only for Tailscale's `.ts.net`
  HTTPS address.
- Ovis for Mac makes the phone address with the Ovis release that runs now, not the one first
  installed, and shows Tailscale's answer when it fails.
- Remove in Ovis for Mac stops at a step that fails (herdr's plugin list included) and shows why,
  and takes the phone address off Tailscale even when the server is down.
- Start in Ovis for Mac no longer adds a login item for herdr set up from a terminal; it runs herdr
  for this login only.
- Ovis for Mac moves herdr's log to `herdr-server.log.1` once it passes 10 MB, when the app opens
  or starts herdr, and its refresh button has a VoiceOver label.
