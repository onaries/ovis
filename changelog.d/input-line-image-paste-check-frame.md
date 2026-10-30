### Maintenance
- The input line's image-paste check waits for the frame that puts the caret after a pasted path
  before it rewrites the line, so on a busy PC that frame no longer collapses the next rewrite's
  selection and makes it add to the line instead of replacing it.
