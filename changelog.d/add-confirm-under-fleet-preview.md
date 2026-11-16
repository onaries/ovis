### Changed
- Under the fleet preview (`OVIS_PREVIEW=fleet`, in the environment or in the plugin's settings
  file, as the server it starts reads it), `ovis add` without `--approve` signs in and shows its QR
  code at a terminal only: where its output or its input is not one, `--print` included, it
  says that it needs a terminal and exits 1 instead of starting the sign-in. After the sign-in it
  names the account that signed in and waits for Enter before it lists this PC in that account and
  shows the QR code; any other line, or the end of the input, shows no code, lists nothing and
  exits 1. Under the preview too, the app the server pairs with (`OVIS_RELAY_APP_URL`) replaces
  `app.ovis.sh` in what `ovis add` and `ovis link --code` print, and `OVIS_CLI_NAME` replaces
  `ovis` in the commands `ovis add` says to run. With `OVIS_PREVIEW` unset, `ovis add` (also
  `link` and `login`) behaves as before.
