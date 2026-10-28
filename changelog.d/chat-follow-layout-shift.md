### Fixed
- Chat keeps following new output to the end when part of the transcript folds on its own: a turn
  settling at the end, or a block above the view folding while the view still glides to the end.
  Before, the list holding the rows in place read as the reader scrolling up: following stopped
  mid-transcript and **New messages** showed.
