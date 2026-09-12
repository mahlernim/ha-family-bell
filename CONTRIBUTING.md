# Contributing

Issues and pull requests are welcome in Korean or English. Use fictional
schedules and speakers in examples; never include credentials or household backups.

## Local checks

Use Python 3.14 with the Home Assistant version being tested:

    python -m pip install homeassistant==2026.9.0 pytest ruff mutagen==1.47.0 ha-ffmpeg==3.2.2
    python -m pytest -q
    ruff check .
    ruff format --check .

The tests create a local Home Assistant object and replace storage, timers and
audio calls. They do not contact a running HA instance. Set
PYTEST_DISABLE_PLUGIN_AUTOLOAD=1 when unrelated pytest plugins are installed.
The explicit Mutagen and HA-FFmpeg packages are Home Assistant TTS dependencies
needed to exercise its real provider lookup API in the config-flow tests.

Use Node.js 24 for the frontend checks:

    npm ci
    npm test
    npx playwright install chromium
    npm run test:browser

Browser tests use a local example fixture and cover editor drafts, concurrent
changes, time zones, routine toggles, backup preview and mobile controls. On Linux,
install browser system dependencies with npx playwright install --with-deps chromium.

## Manual screen-reader check

Playwright checks DOM roles, focus and live-region updates. It cannot establish what
a screen reader actually speaks. Before a release that changes panel feedback, run
this isolated check with a screen reader chosen and controlled by the tester:

1. Start the local fixture with `node tests/browser/server.mjs` and open
   `http://127.0.0.1:8792` in a browser. It uses fictional data and does not contact
   Home Assistant or request real audio.
2. Start the screen reader manually, then edit and save a weekly bell. Confirm the
   saved feedback is announced once. Save a second edit and confirm the repeated
   saved feedback is announced once again.
3. Use **Play saved bell** and confirm the sent/request-only feedback is announced.
   Then open an editor, clear every speaker, and save. Confirm the validation error
   is announced while focus stays in the editor.
4. Return to the preview and leave it open through an unchanged fixture refresh.
   Confirm that old saved, playback, and error feedback is not announced again.

Record the screen reader and browser version, the panel language, and any observed
speech mismatch in the pull request. Do not infer speech behavior from browser tests.

## Panel changes

The panel is shipped as local JavaScript and CSS modules. There is deliberately no
frontend build step. Keep panel-visible text in the local bilingual table in
`frontend/panel-model.js`, with the English value first and the Korean value second.
Keep behavior helpers there when they can be tested with `npm test`.

| Change | Keep aligned |
| --- | --- |
| Panel module URL | `__init__.py`, the `panel-model.js` import, and the `panel.css` URL use the release version as their cache key |
| Panel text | English and Korean entries in `panel-model.js` describe the same behavior |
| Settings | Preserve existing TTS defaults and settings revision behavior unless a separately reviewed change requires them |

To regenerate the illustrative documentation screenshots:

    node tests/browser/capture.mjs

Inspect the resulting light and dark screenshots before committing documentation
images. The fixture contains fictional data and never requests real audio.

## Compatibility and releases

CI checks Python behavior on Home Assistant 2026.7.0 and 2026.9.0, frontend behavior
in Chromium, Ruff, Hassfest and HACS validation. Runtime integration testing does
not establish physical speaker compatibility.

Keep manifest.json, pyproject.toml, package.json, package-lock.json and all frontend
cache keys on the same release version. Run `python tools/check_versions.py` before
opening a pull request. On release tags, CI also checks that the tag matches the
source version. Existing store version 2 and entity unique IDs must remain compatible.
Review migration tests before changing storage.

User-facing documentation and release notes are Korean first, with usable English
coverage. Keep PR descriptions concise and explain the problem, resulting behavior
and relevant tests. Publish from a checked main commit and keep existing tags immutable.
