export const HERDR_WINDOW_CHOICES = {
  separate: {
    releasePaneAway: false,
    followHerdrFocus: false,
    descriptionKey: "Separate: leaving Ovis keeps the pane attached; herdr's selection stays independent.",
  },
  alongside: {
    releasePaneAway: true,
    followHerdrFocus: false,
    descriptionKey: "Use alongside: leaving Ovis releases an unused pane to herdr after a short delay; herdr's selection stays independent.",
  },
  follow: {
    releasePaneAway: true,
    followHerdrFocus: true,
    descriptionKey: "Follow its focus: leaving Ovis releases an unused pane after a short delay; this view follows herdr's selection.",
  },
} as const;

export type HerdrWindowChoice = keyof typeof HERDR_WINDOW_CHOICES;
