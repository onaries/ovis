### Changed
- Switching tabs is faster: a tab's terminal takes input about 100 ms sooner. The bridge passes an
  attach's screen on as soon as herdr draws its text, instead of holding every attach 100 ms.
  The hold stays for an attach that shows no text yet, one that was resized while it started, and
  a pane another web bridge held, so herdr's refusal is still never shown.
