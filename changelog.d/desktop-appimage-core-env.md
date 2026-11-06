### Fixed
- Desktop app (AppImage): terminals no longer inherit the AppImage's own library and data folders,
  which made programs in them load the app's libraries and, after the app quit, point at a folder
  that no longer exists.
