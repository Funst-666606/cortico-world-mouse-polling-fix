# Validation record

Date: 2026-10-26. Coopanion 0.2.11, Windows 11 26H2 build 26300.9711. Package 0.1.8 (stop auto-restore).

## Package

- `package.json` `cortico` block: `kind: world`, `api: 6`, `describe: describe.json`, `os: ["win32"]`.
- Cortico's own `parseExtensionManifest` (bundled from `src/extensions/manifest.ts`): **ok: true, zero warnings**.
- Cortico's own `loadExtensions` (bundled from `src/extensions.ts`) against a fake `extensions/` repo, recorded on 0.1.0; 0.1.1 does not change the manifest or entry:

  ```json
  {
    "name": "cortico-world-mouse-polling-fix",
    "version": "0.1.0",
    "loaded": true,
    "kind": "world",
    "api": 6,
    "webUi": "none",
    "worldId": "mouse-polling-fix",
    "label": "Mouse Polling Fix"
  }
  ```

## Patch

`node test/patch.test.mjs`:

- fake host/page: apply → `forward: false` in both host files, `CURSOR_EVERY_MS = 16`, page handler wrapped with `__mousefixRunPointer` and a `requestAnimationFrame` scheduler; backups recorded; second apply `changed: false`;
- poll change 16 → 8; restore returns the exact original bytes of all three files;
- Coopanion update simulation: replace the patched host with a new original, re-apply, restore the **new** original (not the old backup);
- unsupported host code is refused and left untouched;
- unknown page block is optional: host patch still succeeds, page is `skipped`, file untouched;
- manually patched file without a backup record is refused;
- **real 0.2.11 files**: `host/electron-main.cjs`, `host/mouse-lease.cjs` and `web/pet-app.js` copied from `resources/app/node_modules/cortico-world-desktop-pet/`, patched and restored byte-for-byte.

The patched real `web/pet-app.js` was also parsed with `node --input-type=module --check`: **syntax ok**.

0.1.3 additionally verifies:

- while `pressing`, the page's `pointermove` listener returns immediately; `body.pointer('move')` and `followDrag` come from the 16 ms `pet:cursor` report;
- the host sends cursor coordinates outside the window;
- a live 0.1.1 host/page (no 0.1.3 markers) upgrades from its recorded backups: host gets the outside-window cursor report, page gets the 0.1.3 sample, `restore` returns the real 0.2.11 originals;
- the patched page passes `node --input-type=module --check`.

0.1.4 additionally verifies:

- `web/kit/body.js` drag easing changes from `ease(28, dt)` to `ease(200, dt)`, so the pet no longer trails the cursor by several frames;
- the page frame loop is forced to `full` while `pressing`;
- cursor drag reports are queued to one `requestAnimationFrame` per frame, and a pending point is cleared on down/up/leave;
- a live 0.1.3 host/page plus original body.js upgrades from the recorded backups; `restore` returns the real 0.2.11 originals;
- patched `pet-app.js` and `body.js` pass `node --input-type=module --check`.

0.1.5 additionally verifies:

- while pressing, the pointermove listener keeps only the latest real cursor position and applies it once per `requestAnimationFrame`; the 16 ms `pet:cursor` report is the fallback;
- this restores display-rate target updates on a 120/165 Hz panel instead of the 60 Hz cursor-only path, which was the “continuous follow but 60 steps/s” stutter also seen at 125 Hz;
- a live 0.1.4 host/page upgrades from the recorded originals; `body.js` stays patched;
- the patched 0.2.11 page passes `node --input-type=module --check`.

0.1.6 additionally verifies:

- while pressing, `pointermove` returns at once and the drag position comes from the host's 5 ms `pet:cursor` report, queued to one `requestAnimationFrame`;
- `CURSOR_EVERY_MS` is 5, `pollMs` defaults to 5 and accepts 4–100;
- the host calls `timeBeginPeriod(1)`; a local Node check with koffi/winmm measured 188 ticks/s for a 5 ms interval (without it, 66/s at Windows' ~15.6 ms clamp);
- a live 0.1.5 host/page upgrades from the recorded originals; `body.js` stays patched;
- the real 0.2.11 page/body still pass `node --input-type=module --check`.

0.1.7 additionally verifies:

- `electron-main.cjs` contains the `pet:dragStart` handler, `GetAsyncKeyState(VK_LBUTTON)` call, `pet:dragEnd` send and the force click-through in the 5 ms tick;
- `preload.cjs` exposes `dragStart()` and `onDragEnd()`;
- the page calls `host.dragStart()`, ignores `pointerleave` while pressing, ends on `button:false` / `pet:dragEnd`, and does not re-interactive during a native drag;
- `restore` returns all five files (host, lease, preload, page, body) to the fixture bytes;
- the real 0.2.11 page/body/preload pass syntax checks.

## World

`node test/world.test.mjs`:

- default export `id: mouse-polling-fix`, `defaults: { enabled: false, pollMs: 5, autoApply: true }`;
- `describe.json` deep-equals `src/describe.js`;
- three tools, handlers present, display-only `summary` stripped from the model schema.

`node test/auto.test.mjs`:

- with `COOPANION_VERSION` / `CORTICO_SUPERVISED` set and cwd at a fake app root, `create({enabled:true, autoApply:true})` patches before `start()`;
- page wrapper applied in the same pass;
- `mouse_fix_status` reports `patched` and `0.2.11`;
- `world.stop()` restores all five files before `mouse_fix_restore` is called;
- `mouse_fix_restore` returns all five files to the fixture bytes.

## Published

- npm latest: `cortico-world-mouse-polling-fix@0.1.7`, published 2026-10-27 as funst. 0.1.8 is local until published.
- Market: `[sync]` issue #347 listed 0.1.7; the package was then blocked by #348 for rewriting program files, so 0.1.8 is out-of-market.
- npm 0.1.7 tarball shasum `d4eab4cfa3927cf3c7994c9bfc6ae33cd99c0781`.

## Not done here

- npm publish: done as funst (0.1.2 and 0.1.7); 0.1.8 is local.
- No live install into `F:\coo\Coopanion`: the agent's file sandbox only writes under the session workspace. The host files are writable by the user (NTFS `Authenticated Users: Modify`), so Coopanion itself can patch them; the package tests use copies of the real 0.2.11 files.
- No real 8000 Hz measurement in this session. 0.1.0 removed the global hook and the user reported a large improvement; 0.1.1 adds the per-frame page coalescing aimed at the remaining drag stutter, which still needs the user's 8000 Hz test.
