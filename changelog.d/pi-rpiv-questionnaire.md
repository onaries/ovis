### Fixed
- Pi's rpiv ask-user-question questionnaires show their real choices in Chat instead of only
  arrow, Enter and Escape controls. Single choices, typed answers, multiple choices and the final
  review use the widget's cursor and submit keys, with a fresh check before answering. Incomplete
  lists, side-by-side previews and terminal-owned notes or multi-choice custom drafts stay in Terminal.
- Pi questionnaires retain multi-paragraph question text and accept model footers with thinking
  disabled or model names containing "working". Typed answers reject control characters before
  sending any input, so a newline cannot prematurely submit a question or affect the next screen.
- Pi's system theme identifies the active tab by neutral text versus dim/green inactive tabs,
  not only a colored background. Reviews use Ovis's existing answer summary; an unanswered
  question stays visible and can be revisited, without falling back to arrow/Enter buttons
  or offering a partial submission.
- Pi multi-question cards show question chips and Back, including returning from review to edit
  saved choices or custom answers. Switching verifies the native current tab and never submits an
  answer. Unsent web edits must be submitted or cleared before switching, rather than lost.
- After a Pi questionnaire answer, Chat no longer briefly replaces the closing widget with generic
  arrow/Enter/Escape controls while Herdr's blocked state catches up. Recognized next questions
  still appear immediately, and a persistent unknown blocker remains available after settling.
