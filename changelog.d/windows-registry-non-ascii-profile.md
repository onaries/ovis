### Fixed
- A Windows PC whose user profile has non-ASCII characters (`C:\Users\홍길동`) connects over SSH.
  Before, its bridge started but the app never found it, and every Connect or bridge update ended
  in "Bridge did not start" with nothing in the bridge's log.
