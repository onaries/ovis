### Changed
- A numbered list whose numbers do not count up shows them as written, instead of renumbering
  them from its first: `1.` then `4.` reads 1 and 4, `1.` `3.` `2.` reads 1, 3, 2, and an agent's
  slip (`1.` `2.` `3.` `5.`) shows as typed. This holds wherever Markdown is drawn: chat messages
  and replies, the file viewer's Markdown preview, omp question cards and release notes. A list
  begun all one number (`1.` `1.` …) still counts up, and an omp question card whose list omp
  renumbers on its screen stays as omp draws it.
