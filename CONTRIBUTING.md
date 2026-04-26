# Contributing to Gopherfy

## Branches

Use prefixes: `feat/<topic>`, `fix/<topic>`, `chore/<topic>`.

## Commits

Prefer [Conventional Commits](https://www.conventionalcommits.org/) (`feat:`, `fix:`, `chore:`, etc.).

## Code standards

- **SQL:** use prepared statements only; never concatenate user input into SQL strings.
- **Tests:** new pure logic should ship with Jest tests in `__tests__` next to the code.
- **Logging:** use Pino via `src/lib/logger.js`; do not add `console.*` (ESLint enforces this).

## Workflow

Large or security-sensitive changes should follow the phased prompts in [CURSOR_RUNBOOK.md](CURSOR_RUNBOOK.md).

## Local checks

Run `npm test`, `npm run lint`, and `npm run format:check` before opening a PR. Husky runs `lint-staged` on commit when hooks are installed (`npm install` runs `prepare`).

## Pull requests

Keep PRs focused; avoid unrelated refactors. Document behavior changes in the PR description.
