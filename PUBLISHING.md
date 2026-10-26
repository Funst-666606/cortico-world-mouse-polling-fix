# Publishing this World

**Published:** `cortico-world-mouse-polling-fix@0.1.7` on npm, 2026-10-27, as **funst**.

- npm: https://www.npmjs.com/package/cortico-world-mouse-polling-fix
- tarball: https://registry.npmjs.org/cortico-world-mouse-polling-fix/-/cortico-world-mouse-polling-fix-0.1.7.tgz
- market sync: https://github.com/Pal-AI-Lab/cortico-extensions/issues/347 (closed, **listed at 0.1.7**)
- market discussion: https://github.com/Pal-AI-Lab/cortico-extensions/discussions/337
- new tag request: https://github.com/Pal-AI-Lab/cortico-extensions/issues/341 (`performance`, 中文「性能优化」)
- author: funst（QQ 2674459204） · License: MIT

The WebUI market shows it within about 10 minutes (5-minute raw CDN cache plus 5-minute Cortico cache).

The notes below are kept for the next release.

## 1. Publish to npm

The name `cortico-world-mouse-polling-fix` is still free (checked 2026-10-26). From this directory:

```bash
npm login
npm publish --access public
```

`package.json` already carries:

- `"type": "module"`, `"main": "./src/index.js"`
- `"cortico": { "kind": "world", "api": 6, ... }`
- `"keywords": ["cortico-world", ...]`
- `"os": ["win32"]`
- `describe.json` generated from `src/describe.js`

The tarball contains the runtime files, the tests and the describe generator:

```
CHANGELOG.md  IMPLEMENTATION.md  LICENSE  README.md  describe.json  package.json
scripts/write-describe.mjs
src/describe.js  src/icon.svg  src/index.js  src/patch.js
test/auto.test.mjs  test/patch.test.mjs  test/world.test.mjs
```

## 2. Get it into the market

Coopanion's market reads npm; the index repository's Action scans npm periodically. To force a sync immediately, open an issue in `Pal-AI-Lab/cortico-extensions`:

- Title: `[sync] cortico-world-mouse-polling-fix`
- Body:

  ```
  package: cortico-world-mouse-polling-fix
  ```

Or wait for the scheduled sync. The listing shows the npm name, version, description, icon, `os: win32`, and the tools from `describe.json`. The `coopanion` tag is maintainer-only and cannot be self-declared; this package declares `experimental`, `apps` and `performance` (the last one is pending #341).

## 3. Updates

For a new version:

1. Bump `version` in `package.json`.
2. Add a `CHANGELOG.md` entry.
3. `npm publish`.
4. `[sync]` if you do not want to wait.

Coopanion's extension page compares the installed version with npm's `latest` and offers the update. After the update and a Coopanion restart, the World re-applies the patch if the new Coopanion host still matches.

When Coopanion updates its desktop-pet host lines:

1. Run `node test/patch.test.mjs` with `COOPANION_APP_ROOT` pointing at the new `resources/app`.
2. If it fails, update `TARGETS` / `PATCHED` in `src/patch.js` for the new lines.
3. Bump the version, publish, sync.

The goal is that an app update is never silently half-patched: unknown lines are refused, and the user is told to update this plugin.

## 4. Optional: source repository

The package has no `repository` field yet. If you publish the source on GitHub, add it and a `bugs` URL; the market shows both. A repository also gives users an issue tracker and lets `npm` link the source.

## 5. Local install from the packed tarball

If you want to use it before publishing:

```powershell
cd F:\coo\Coopanion\data\extensions
pnpm add file:C:\Users\26744\Desktop\coo鼠标\cortico-world-mouse-polling-fix\cortico-world-mouse-polling-fix-0.1.7.tgz
```

Then restart Coopanion, enable **鼠标回报率修复 / Mouse Polling Fix** in Worlds, and restart once more. The World patches the host during startup, before the pet window is spawned.

To remove the local install, restore first (`mouse_fix_restore`), then:

```powershell
pnpm remove cortico-world-mouse-polling-fix
```

## 6. Reproducing the check locally

```bash
node test/patch.test.mjs
node test/world.test.mjs
node test/auto.test.mjs
npm pack --dry-run
```

The manifest was validated with Cortico's own `parseExtensionManifest` (`world` / api 6): `ok: true`, no warnings.
