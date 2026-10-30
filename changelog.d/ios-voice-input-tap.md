### Fixed
- On an iPhone, tapping the mic records with the browser's speech recognition instead of saying the
  microphone permission was denied: iOS starts it only from a tap, so a touch starts and finishes a
  take by tapping, where a mouse still holds to talk. In a home-screen app, turning Voice input on
  no longer asks for the microphone at once, the request reported to close or reload the app; the
  first tap of the mic asks. Speech recognition that is off on the device (Siri & Dictation) says so
  instead of blaming the permission. Thanks to @osamahbeig for the report and the diagnosis.
