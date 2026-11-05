### Changed
- Opening a PC through the Ovis relay waits for fewer round trips: the PC sends its greeting right
  behind its side of the encrypted handshake instead of waiting for the phone's, and keeps one
  relay connection ready in advance, so a phone no longer waits for the PC to open and prove a new
  one. Older phones and PCs keep working as before.
