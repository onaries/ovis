### Fixed
- A chat send is refused again over a pi draft with a quoted line and an arrow line, over a Qwen Code
  draft whose second line starts with `>`, and over a GJC draft wrapped onto more than one row.
- Claude Code: Send anyway is also withheld when a folded paste placeholder is wrapped inside a word,
  and the refusal now says the box holds a paste or image whose lines are not shown. Typed words that
  only look like the start of a placeholder (`[Image #1` with no closing bracket) keep Send anyway.
