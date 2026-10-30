### Fixed
- The key bar's Show/Hide keyboard control on a touch screen no longer fights itself: its label,
  pressed state and its tap's action are one word from the tap, held until the keyboard measured
  after that tap confirms it or the settle window runs out — a tap can never do the opposite of what
  the control just said, and a quick reversal is not undone by the last animation. The word is the
  tapping pane's own, so another pane's control is never stuck on it. Show puts a keyboard back
  after Android's back gesture (blur and refocus inside the tap; a focus alone raises nothing
  there), and the blur reads as the keyboard going where the measurement is blind (a zoomed page, a
  floating keyboard), the word standing through the hiding animation the measurement still reports.
- Switching the key bar's Input line and direct typing on a touch screen no longer raises a
  keyboard the user put away (including after Android's back gesture), and with the keyboard up
  the new mode's field takes it, focus and all. A keyboard the page cannot measure (an iPad's
  floating keyboard, a zoomed page) counts as down there: Show brings it back after the switch.
