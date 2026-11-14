### Fixed
- The Android app no longer shows a black screen for two minutes on an address that does not
  answer: it says which PC it is opening, with Change PC, and after 20 seconds says that the PC
  did not answer and why that may be, as the iOS app does.
- The Android app checks that an address is Ovis before it opens it: the address of another web
  server (or of herdr itself) is no longer saved as the PC with no way back. The connect screen
  says what answered instead, and a saved PC that no longer answers as Ovis opens on the error
  page, which has Change PC.
- When nothing listens at the address, the app now says that Ovis has to run on the PC (herdr
  alone is not enough), that Ovis listens only on the PC itself by default, and that localhost on
  a phone is the phone.
