### Changed
- The machine profile (a preview) answers a failed herdr call with its own code and sentence, in
  its HTTP answers and its error, submit and pending frames: the bridge's own error codes and the
  herdr codes the app acts on are kept, any other is `herdr_error`, and such an answer is never
  stored. A layout answer keeps the reasons the app acts on and gives `herdr_error` for any other.
  A pane herdr could not restore keeps its `restore_error`, in one sentence of the profile's own,
  and a move herdr did not make says where it left the pane. An ordinary server answers as before.
