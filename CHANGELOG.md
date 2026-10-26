# Changelog

## 0.1.7 — 2026-10-27

- Drag now uses **click-through + native button polling**, per the 0.1.6 result that 2000+ Hz
  still stutters: after pointerdown the page asks the host to make the window click-through, so
  Chromium receives no mouse-move messages at all. The host reads `GetAsyncKeyState(VK_LBUTTON)`
  on its 5 ms tick and sends `pet:cursor` with `button` plus a `pet:dragEnd` on release.
- The host also calls Win32 `ReleaseCapture()` on drag start, so Chromium's native mouse capture
  cannot keep sending the pet window the moves that click-through is meant to avoid.
- The initial mousedown was consumed by the pet window; the underlying app only sees moves/up
  without a down, so it does not get a click. This is the tradeoff that makes click-through safe
  enough to use for a drag.
- `preload.cjs` exposes `dragStart()` / `onDragEnd()`; the page no longer calls
  `setInteractive(true)` during a native drag, ignores `pointerleave` while pressing, and ends
  the drag on `button:false` or `pet:dragEnd`.
- Fallback: when the host/preload does not have the drag API, the page keeps the 0.1.6 path.
- Tests cover the host drag block, `GetAsyncKeyState`, preload APIs, page click-through state and
  restore of all five files.

## 0.1.6 — 2026-10-27

- 0.1.5 was smooth at 125–2000 Hz but still stuttered above 2000 Hz on a 180 Hz display. The
  pointermove path still ran one page/JS task per physical event. 0.1.6 ignores `pointermove`
  during a drag and drives the pet entirely from the host cursor report, now at **5 ms**
  (~200 Hz, matching a 180 Hz display).
- The 5 ms cursor report is queued to one `requestAnimationFrame`; the 200/s input is decoupled
  from the 180 Hz render.
- `pollMs` default is 5, minimum 4; existing configs with 16 are upgraded by the patch. The host
  also calls Win32 `timeBeginPeriod(1)` so a 5 ms `setInterval` is really ~5 ms (without it
  Windows clamps it to ~15.6 ms).
- The drag still uses the 0.1.4 `ease(200)` follow; `body.js` and `frame-full` are unchanged.
- If 2000+ Hz still stutters after this, the remaining cost is Chromium's native mouse-message
  dispatch, not page work; that needs click-through/native input rather than more page tuning.

## 0.1.5 — 2026-10-26

- During a drag the pointer target is taken from the latest real `pointermove` and applied once
  per `requestAnimationFrame`; the 16 ms `pet:cursor` report remains the fallback (and drives
  hover). This restores display-refresh-rate target updates (120/165 Hz), which the 60 Hz
  cursor-only path had reduced to 60 steps/s — the "continuous follow but one-frame-at-a-time"
  stutter that also appeared at 125 Hz.
- The tight 200/s drag easing from 0.1.4 stays; target updates now match the render rate.
- Upgrading from 0.1.4 reuses the recorded page original and applies 0.1.5 on top.

## 0.1.4 — 2026-10-26

- The drag position now follows tightly: the figure kit's drag easing changes from 28/s to 200/s
  (`pet.dx`/`pet.dy`), so at 60 Hz the pet reaches 96% of the cursor distance per frame instead
  of 37%. This is the "pet can't keep up" fix; the old easing was intentional softness.
- The page's frame loop is forced to full frame rate while `pressing`, even if the figure layout
  has not reported `moving` yet.
- Cursor drag reports are coalesced into one `requestAnimationFrame` before `body.pointer('move')`
  and `followDrag`, so two host ticks cannot double-post and a missing tick cannot leave a stale
  position; a pending drag point is cleared on down/up/leave.
- `web/kit/body.js` is a new optional target; if it does not match, the page/host fixes still
  apply and `mouse_fix_status` reports `body.js: skipped`.
- Upgrades from 0.1.1/0.1.3 use the recorded page original and patch 0.1.4 on top.

## 0.1.3 — 2026-10-26

- Drag is now sampled from the host's 16 ms `pet:cursor` reports instead of every `pointermove`:
  while `pressing`, the page's `pointermove` listener returns at once, and the cursor report feeds
  `body.pointer('move')` and `followDrag`. This removes the per-event page/iframe work during a
  drag even at 8000 Hz.
- Eye/body tracking also follows the 16 ms cursor reports while click-through.
- The host now sends cursor coordinates even when the cursor is outside the window, so a drag
  across displays still follows; the page releases the mouse when not pressing.
- Upgrading a 0.1.1 page wrapper: the recorded original backup is restored first, then the 0.1.3
  page is applied; no need to uninstall.
- Tests cover the 0.1.1 host/page upgrade and the real 0.2.11 files.
- Declares the `performance` market tag (中文「性能优化」) in addition to `experimental`/`apps`; the market index vocabulary needs `[new-tag] performance` (#341) before the tag is shown.

## 0.1.2 — 2026-10-26

- npm/市场元数据：作者 funst（QQ 2674459204），MIT；主标题与介绍带中文，并补英文 locale。
- README / IMPLEMENTATION 明确“两次重启”激活流程：安装后重启，启用后再重启，否则不生效。
- 新增 `IMPLEMENTATION.md`（代码详细步骤与思路）。
- 0.1.1 的 host/page 补丁不变。

## 0.1.1 — 2026-10-26

- Fixes the remaining **drag stutter at 8000 Hz**. The desktop-pet page (`web/pet-app.js`) now
  records the latest `pointermove` and runs the original handler once per animation frame,
  instead of once per physical event; `body.pointer('move')` into the figure iframe is likewise
  at most once per frame. Pending moves are cleared on `pointerup`/`pointercancel`/`pointerleave`.
- The page patch is optional: if a future Coopanion changes that block, the host patch still
  applies and `mouse_fix_status` reports `pet-app.js: skipped`.
- `mouse_fix_status` now reports all three files.

## 0.1.0 — 2026-10-26

- First release.
- Patches the Coopanion desktop-pet host (`cortico-world-desktop-pet` 0.2.0, shipped with Coopanion 0.2.10/0.2.11) to call `setIgnoreMouseEvents(..., { forward: false })` and poll the cursor every 16 ms.
- Backups (`sha256`, content-addressed), state file, idempotent apply, exact-byte restore, and refusal on unknown host code.
- Tools: `mouse_fix_status`, `mouse_fix_apply`, `mouse_fix_restore`.
- Windows only.
