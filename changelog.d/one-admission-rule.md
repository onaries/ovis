### Added
- A headless PC can approve a phone waiting to pair by comparing digits from its terminal:
  `bun scripts/plugin.ts pair --approve` shows the digits and asks y/n.

### Changed
- On a PC linked to an account, only a phone linked to that account with drive access may start a
  pairing code through the relay or approve a waiting device, and it must pick the new device's
  digits out of three. Every connected device is told who approved each new device.
