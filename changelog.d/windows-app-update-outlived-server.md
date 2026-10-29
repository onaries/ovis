### Fixed
- Ovis for Windows and install.ps1 now stop an Ovis server from before the rename (0.4.12 and older)
  that kept running after herdr closed, so Update no longer fails with "the file is in use" and then
  keeps showing the same Update screen.
- Try again after a failed Update in Ovis for Windows reads the PC again instead of running the old
  server's removed files ("Module not found").
- Ovis for Windows shows the phone QR code for a server that asks for a token, instead of telling a
  PC that already has Tailscale to install it.
- The log in Ovis for Windows shows the installer's messages as plain lines, not raw PowerShell
  CLIXML.
