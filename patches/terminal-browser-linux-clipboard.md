# terminal-browser Linux clipboard

terminal-browser 0.15.3's CLI receives hosted `clipboard` messages but handles them
only on macOS with `pbcopy`. On Linux the message is discarded. The accompanying
patch emits OSC 52 on the CLI's terminal stream, which Ovis already decodes into
the viewing device's clipboard. It covers text, links, recording paths and the
text description from element selection. Element selection also forwards its text
after the separate Electron screenshot clipboard write.

Apply from the installed application directory:

```sh
cd "$HOME/.local/share/terminal-browser/app"
patch -p1 < /path/to/ovis/patches/terminal-browser-linux-clipboard.patch
```

Restart terminal-browser after applying. An upgrade may replace this patch; inspect
the new CLI before reapplying. Ovis's Clipboard from a pane setting must be enabled,
and the viewing browser must allow clipboard writes. Element screenshot copying
uses Electron's separate image clipboard and is outside this text transport.
