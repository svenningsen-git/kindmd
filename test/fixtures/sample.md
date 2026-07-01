# Onboarding Redesign

Draft notes on shortening time-to-first-result.

## What we are changing

We will rebuild onboarding around a single guided task rather than a tour of
every feature. The goal is one clear win in under two minutes.

- Replace the six-step tour with one guided task
- Defer account settings until after the first win
- Add inline tips instead of modal popups

## How we will measure it

Success is a lift in day-one activation and a shorter median time-to-first-result.

```js
function activate(user) {
  return user.firstWin && user.timeToValue < 120;
}
```

## Open questions

Should we keep the old tour as an opt-in? The accent color `#6B2737` is under review.
