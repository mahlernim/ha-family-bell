# Contributing

Issues and pull requests are welcome in Korean or English. Use fictional
schedules and speakers in examples; never include credentials or household backups.

## Local checks

Use Python 3.14 with the Home Assistant version being tested:

    python -m pip install homeassistant==2026.9.0 pytest ruff
    python -m pytest -q
    ruff check .
    ruff format --check .

The tests create a local Home Assistant object and replace storage, timers and
audio calls. They do not contact a running HA instance. Set
PYTEST_DISABLE_PLUGIN_AUTOLOAD=1 when unrelated pytest plugins are installed.

Use Node.js 24 for the frontend checks:

    npm ci
    npm test
    npx playwright install chromium
    npm run test:browser

Browser tests use a local example fixture and cover editor drafts, concurrent
changes, time zones, routine toggles, backup preview and mobile controls. On Linux,
install browser system dependencies with npx playwright install --with-deps chromium.

To regenerate the illustrative documentation screenshots:

    node tests/browser/capture.mjs

Inspect the resulting light and dark screenshots before committing documentation
images. The fixture contains fictional data and never requests real audio.

## Compatibility and releases

CI checks Python behavior on Home Assistant 2026.7.0 and 2026.9.0, frontend behavior
in Chromium, Ruff, Hassfest and HACS validation. Runtime integration testing does
not establish physical speaker compatibility.

Keep manifest.json, pyproject.toml, package.json, package-lock.json and all frontend
cache keys on the same release version. Existing store version 2 and entity unique
IDs must remain compatible. Review migration tests before changing storage.

User-facing documentation and release notes are Korean first, with usable English
coverage. Keep PR descriptions concise and explain the problem, resulting behavior
and relevant tests. Publish from a checked main commit and keep existing tags immutable.
