### Changed
- The app opens on less data: the files a browser loads before the app can start (the main
  script, the modules it needs at once and the styles) are sent with Brotli's best compression,
  about 150 KB (14%) smaller, where the browser accepts Brotli. A build takes a few seconds longer.
