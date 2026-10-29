### Maintenance
- The xterm source build compiles the exact files its cache key was made from, and the key now
  covers xterm's package manifest, so a source edited mid-build or a changed typings entry can no
  longer reuse an old build. A killed build's leftover staging directory is cleared by the next
  build, and the published build is readable by other users of the checkout.
- The Windows-native tests wait for the desktop child's whole result file instead of parsing it
  half written, and every Windows-only case has a 30 s budget for busy hosted runners.
