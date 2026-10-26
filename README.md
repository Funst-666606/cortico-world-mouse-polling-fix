# 鼠标回报率修复 · Mouse Polling Fix

A **Cortico World** for [Coopanion](https://github.com/Pal-AI-Lab/Coopanion) that stops the desktop pet from processing every physical mouse event.

一个给 Coopanion 用的 **Cortico World**：让桌宠不再按鼠标回报率逐事件工作。

> Status: experimental, Windows only, and it **modifies the installed Coopanion desktop-pet host**. Read [Risks](#risks) before enabling. It is not an official Pal AI Lab extension.
>
> 状态：实验性、仅 Windows，并且会**修改已安装的 Coopanion 桌宠宿主文件**。启用前请读 [Risks](#risks)。这不是 Pal AI Lab 官方扩展。

**作者 / Author:** funst（QQ **2674459204**） · **License:** MIT（宽松开源协议） · **npm:** [cortico-world-mouse-polling-fix](https://www.npmjs.com/package/cortico-world-mouse-polling-fix) · **GitHub:** [Funst-666606/cortico-world-mouse-polling-fix](https://github.com/Funst-666606/cortico-world-mouse-polling-fix)

**标签 / Tags:** `experimental`、`apps`、`performance`（中文显示「性能优化」，需市场索引 #341 通过后由市场显示）。

**激活必须重启两次 / Two restarts:** 安装后重启 Coopanion；在 Worlds 启用「鼠标回报率修复」后**再重启一次**。只做一步不会生效。详见 [IMPLEMENTATION.md](IMPLEMENTATION.md#4-激活必须重启两次)。

## The problem

On Windows, Coopanion 0.2.10/0.2.11 ships Electron 44.4.4. Its pet window covers the whole work area and, while click-through, calls:

```js
win.setIgnoreMouseEvents(true, { forward: true });
```

On Windows that `forward: true` is implemented with a global `WH_MOUSE_LL` hook. Every physical mouse move runs a hook callback in the pet-host process (a few `user32` calls) and posts a `WM_MOUSEMOVE` to the renderer; the page handles another `pointermove`. At 1000 Hz that is about 1000 callbacks and up to 1000 cross-process messages per second. Above roughly 500 Hz the queue stops draining and the desktop/pet feels laggy. Hiding the pet does not remove the hook; it stays installed with the window.

The full diagnosis and the upstream proposal are in [Coopanion #414](https://github.com/Pal-AI-Lab/Coopanion/issues/414).

## What this World does

It patches the installed `cortico-world-desktop-pet` host files and wraps the pet page's `pointermove` handler:

| File | Before | After |
|---|---|---|
| `host/electron-main.cjs` | `win.setIgnoreMouseEvents(true, { forward: true });` | `... { forward: false });` |
| `host/electron-main.cjs` | `CURSOR_EVERY_MS = 100` | `5`; also calls `timeBeginPeriod(1)` so 5 ms is not clamped to Windows' 15.6 ms timer |
| `host/electron-main.cjs` | cursor report only inside the window | page coordinates also outside, so a drag across displays still follows |
| `host/mouse-lease.cjs` | `setIgnoreMouseEvents(!hold, { forward: true })` | `... { forward: false });` |
| `host/electron-main.cjs` | no drag channel | on `pet:dragStart` calls `ReleaseCapture()`, makes the window click-through and polls `GetAsyncKeyState(VK_LBUTTON)`; sends `pet:dragEnd` on release |
| `host/preload.cjs` | only `setInteractive` | adds `dragStart()` and `onDragEnd()` |
| `web/pet-app.js` | original `pointermove` handler runs per event | wrapper; during a native drag the window is click-through and the 5 ms `pet:cursor` report drives the drag, queued to one per `requestAnimationFrame` |
| `web/kit/body.js` | drag position eases at 28/s | 200/s: the pet follows the cursor instead of trailing it |

With `forward: false`, Electron never installs `WH_MOUSE_LL`. The pet page already receives `pet:cursor` reports from the host and uses them to take the mouse; 5 ms matches a 180 Hz display. When the page does take the mouse, pointerdown/up still come from real events.

0.1.1 wrapped the page handler to one per frame; 0.1.3 stopped consuming `pointermove` during a drag and used the host's 16 ms cursor report; **0.1.4** tightened the figure kit's drag easing (28/s → 200/s) and forced full frame rate while pressing. **0.1.5** moved the drag target to the latest real `pointermove`, which fixed 125–2000 Hz on a 180 Hz display but still ran one page/JS task per physical event. **0.1.6** goes back to cursor-only during a drag, now at **5 ms (~200 Hz)**: above 2000 Hz the per-event `pointermove` dispatch itself was the stutter, so the page ignores it while pressing and the 200/s cursor report is queued to the 180 Hz render. **0.1.7** removes the remaining Chromium mouse-message dispatch: at pointerdown the window becomes click-through and the host polls the left button with `GetAsyncKeyState`; 2000–8000 Hz never enters the page, and `pet:dragEnd` ends the drag. The initial mousedown was already consumed by the pet, so the app underneath sees no down and does not get a click.

The patch is deliberately narrow: it only touches those exact lines/blocks in that one package, refuses unknown code, writes a backup before the first change, is idempotent, and can restore the exact original bytes. The page block is optional: if a future Coopanion rewrites it, the host patch still applies and the page is left alone.

It does **not** modify the AI core, the Coopanion main process, your memory, or any other extension file.

## Install

### npm / manual (out-of-market)

The package is **blocked from Coopanion's extension market** (it rewrites five program files; see
[the block notice](https://github.com/Pal-AI-Lab/cortico-extensions/pull/348)). Install it
manually only if you understand that:

```bash
# npm 0.1.7 is published; 0.1.8 (stop auto-restore) is local until published:
pnpm add file:<path-to>/cortico-world-mouse-polling-fix-0.1.8.tgz
```

This is an **out-of-market mod**, not a market extension: no market card, no automatic update,
and no official support. It is not listed or recommended by the market.

Then:

> **必须重启两次，否则不生效：** 安装扩展后重启一次（加载新 World）；在 Worlds 启用「鼠标回报率修复」后**再重启一次**（在桌宠宿主启动前写入补丁）。只做一步不会生效。

1. Restart Coopanion so the new World is loaded.
2. Open **Worlds** and enable **鼠标回报率修复 / Mouse Polling Fix**.
3. Restart Coopanion once more. On the next start the World patches the host **before** the pet window is spawned.
4. Set the mouse to your highest polling rate (8000 Hz) and drag the pet; ask Coo to call `mouse_fix_status` if you want the current state.

The World is disabled by default. Enabling it once is enough; the setting survives app restarts.

If you already run 0.1.0–0.1.7: install 0.1.8, restart, and check `mouse_fix_status` shows
`pet-app.js: patched` and `body.js: patched`. 0.1.8 adds automatic restore on `stop()`.

### Local development install

```bash
# in Coopanion's data/extensions
pnpm add file:/path/to/cortico-world-mouse-polling-fix
```

## Tools

| Tool | What it does |
|---|---|
| `mouse_fix_status` | Read-only: Coopanion/host versions, each file's state (`patched`, `original`, `skipped`, `unsupported`), backup paths, last error. |
| `mouse_fix_apply` | Re-apply the patch (optional `poll_ms` 4–100, default 5). Useful after a Coopanion update or with `autoApply: false`. |
| `mouse_fix_restore` | Restore the exact bytes from the backups. Refuses if the current file is neither the patched nor the original bytes, so an app update or manual edit is never overwritten silently. |

## After a Coopanion update

The Coopanion updater replaces `resources/app`, so the patch is gone until the next start. On the next launch, with the World still enabled, `create()` sees the new original and re-applies the patch before the pet host starts. The extension page shows an update when a new version of this plugin is on npm.

If the new Coopanion changed the host lines, the plugin **refuses to guess**: `mouse_fix_status` reports `unsupported`, and the files stay untouched. Update this plugin to a version that supports the new lines (or restore and wait). This is the intended update path: the app updates, the plugin updates, the patch is re-applied.

## Restore and uninstall

Disabling the World calls `stop()`, which restores the five files automatically. The already
loaded pet host keeps the patched code until Coopanion restarts; **restart Coopanion to unload
it fully**. Ask Coo to call `mouse_fix_restore` if you want to restore without disabling the
World, then restart.

A killed process or an uninstall that does not call `stop()` cannot run the restore hook; run
`mouse_fix_restore` before removing the package. The backups and state live in:

```
<Coopanion data>/mouse-polling-fix/
  state.json
  backups/<sha256>/electron-main.cjs
  backups/<sha256>/mouse-lease.cjs
  ...
```

Removing the extension is not a guaranteed restore: if `stop()` did not run, run
`mouse_fix_restore` first or restore the files from those backups.

## Configuration

The World's config section (`worlds.mouse-polling-fix` in `config.json`) accepts:

```jsonc
{
  "enabled": true,
  "autoApply": true,   // patch in create(), before the pet host starts
  "pollMs": 16         // 8..100; lower = more responsive, higher = cheaper
}
```

`autoApply: false` is for people who want to inspect first and call `mouse_fix_apply` manually.

## Risks

- **It edits the installed application.** Only the lines/blocks above, with backups, but an app update or a virus scanner may notice. If Coopanion is installed under `Program Files`, the user may not have write permission; the patch then fails and reports why. A per-user install or the portable build is easier.
- **It is version-sensitive.** It targets the host and page shipped with Coopanion 0.2.10/0.2.11 (`cortico-world-desktop-pet` 0.2.0). It matches lines/blocks, not version numbers; a future host/page that looks different is refused rather than half-patched. The page block is optional, so a page change alone does not stop the host fix.
- **Click-through drag relies on the initial mousedown being on the pet.** While dragging, the window ignores the mouse and the app underneath gets move/up without a matching down, so it should not click. An app that acts on a lone button-up is the exception; test over a scratch window first.
- **Drag ends only through the host's left-button poll.** On Windows with koffi available this is the normal path; if the native read fails, the page keeps the legacy pointer-event path. Releasing outside the window still ends the drag because the host polls the button globally.
- **Raises the Windows timer resolution to 1 ms while Coopanion runs.** The 5 ms cursor poll needs it; Windows otherwise clamps short timers to ~15.6 ms. This can slightly increase power use. It is released when the pet host process exits.
- **The first frame of hover may still click through.** With `forward` off, the page learns the cursor is over the pet from a 5 ms poll. Clicking the pet within that first frame can land on the window below. In exchange, no global hook is installed at all.
- **The figure stops tracking the cursor across empty desktop.** While click-through, the page no longer receives every `pointermove` (that is the point). Its eye/body tracking resumes when the cursor reaches the pet; hover buttons still work from the 5 ms `pet:cursor` report. Keeping `forward: true` would keep the tracking and the lag.
- **Windows only.** `package.json` declares `"os": ["win32"]`; the mount is not tested on macOS/Linux. The Electron hook exists on macOS too, but the app bundle is signed/read-only, so patching it is a different problem.
- **Not official.** This is a community mod, not a Pal AI Lab extension. Do not report its bugs as Coopanion bugs; use this package's issue tracker.
- **No telemetry/network.** The World reads and writes only the app files and its own state/backups.

## How it works (short)

`src/patch.js` locates the Coopanion app directory from the Core's cwd (or `resources/app` next to the executable), checks `package.json` says `coopanion`, and then only touches `node_modules/cortico-world-desktop-pet/host/{electron-main.cjs,mouse-lease.cjs}` and `web/pet-app.js`. Each required target must match exactly once; the patched result is verified by re-classifying it before and after the write. The page block is optional, so a page that does not match is left untouched. Backups are content-addressed (`sha256`) and never overwritten, so an old app version's original cannot quietly replace a new one. `state.json` records the original and patched hashes; `restore` uses them to refuse conflicting files.

`src/index.js` is the World. `create()` runs for every World before any World starts (the `WorldAssembly` constructor), which is why the patch lands before the desktop-pet host is spawned. `start()` verifies and logs. The three tools are thin wrappers around `patch.js`.

## 代码详细步骤与思路

实现细节、两阶段修复、`create()` 为什么赶在桌宠窗口之前、两次重启的激活流程、备份/还原/更新链路，见 [IMPLEMENTATION.md](IMPLEMENTATION.md)。

## Development

```bash
node test/patch.test.mjs    # fake app + real 0.2.11 files when COOPANION_APP_ROOT is set
node test/world.test.mjs    # World/describe shape
node test/auto.test.mjs     # Coopanion environment + create() auto-apply
node scripts/write-describe.mjs
```

No dependencies. Node 22+.

## License

MIT（宽松开源协议）. Copyright (c) 2026 funst（QQ 2674459204）. See [LICENSE](LICENSE).
