# Contributing to B-Music

Thank you for helping improve B-Music. Bug fixes, tests, documentation, accessibility improvements, and carefully scoped features are welcome.

Participation in this project is governed by the [Code of Conduct](CODE_OF_CONDUCT.md). For usage questions and supported environments, read [SUPPORT.md](SUPPORT.md) before opening an issue.

## Before opening a change

- Search existing issues and pull requests.
- Open an issue first for large behavior, storage-schema, or API changes.
- Keep the App and kernel boundaries intact.
- Never include real cookies, storage-state files, signed media URLs, credentials, browser profiles, or extracted media in an issue, test, commit, or log.
- Work only with authorized CTF material or videos you can normally access.

## Development setup

Kernel tests:

```bash
cd kernel
python -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/python -m pytest app/tests
```

On Windows, use `.venv\Scripts\python.exe` and `.venv\Scripts\pip.exe`.

App checks:

```bash
cd bili-music-app
npm ci
npm test
npm run typecheck
npm run build
```

Container configuration:

```bash
docker compose -f kernel/docker-compose.yml config --quiet
```

## Pull requests

- Keep changes focused and explain the user-visible effect.
- Add or update tests for changed behavior.
- Update public docs when an API, environment variable, or operational step changes.
- Confirm that generated artifacts, local databases, `.env` files, and session data are not staged.
- Describe security-boundary impact explicitly when touching login, profiles, artifacts, proxying, or extraction strategies.

By contributing, you agree that your contribution is licensed under Apache-2.0.
