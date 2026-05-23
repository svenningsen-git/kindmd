# Contributing to kindmd

Thanks for thinking about contributing. kindmd is intentionally small — read
this first so we don't waste each other's time.

## The kindmd philosophy

kindmd is **deterministic, opinionated, and stays small**. It says no to:

- AI / LLM calls in the render path
- Web fonts or external network fetches
- Theming, color customisation, or a config file
- Telemetry of any kind
- Modification of the source markdown

If your change conflicts with one of those, please open an issue first so we
can talk it through before you write code.

## How to propose a change

1. **Open an issue first** for anything non-trivial. Bug, feature, or refactor
   — describe the problem before proposing the solution.
2. **Fork the repo**, then clone your fork:
   ```bash
   git clone https://github.com/<your-username>/kindmd
   cd kindmd
   npm install
   ```
3. **Create a branch off `main`**:
   ```bash
   git checkout -b fix/<short-description>
   ```
4. **Make your change.** Match the existing palette (oxblood / paper / ink)
   and code style. Add or update tests if you touched render logic.
5. **Run the smoke tests locally**:
   ```bash
   npm test
   ```
6. **Open a pull request.** CI will re-run the tests; please make sure they
   stay green. Keep PRs focused — one logical change per PR.

## Code style

- No new dependencies unless we've talked about it.
- Comments explain **why**, not what. The code should already say what.
- WCAG 2.1 AA is the floor. If you touch interactive UI, test with VoiceOver.
- Match the existing palette via the CSS custom properties in
  `client/styles.css`. No hard-coded hex unless it's a one-off shade.

## Development quickstart

```bash
npm install        # install deps
npm test           # smoke tests (renderer + tree)
npm run app        # launch the Electron app in dev
npm start          # CLI / browser mode
```

## Releasing (maintainers only)

```bash
npm run dist            # build the .app bundle
npm run install-app     # copy to /Applications, sign, register as default handler
```
