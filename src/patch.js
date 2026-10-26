/**
 * The patch itself. This module touches only the Coopanion desktop-pet host package:
 * - host/electron-main.cjs: the first `setIgnoreMouseEvents(true, { forward: true })`
 *   and the cursor poll interval;
 * - host/mouse-lease.cjs: the lease's `setIgnoreMouseEvents(!hold, { forward: true })`;
 * - web/pet-app.js (optional): wraps the pointermove body so it runs at most once per frame;
 *   while dragging it ignores pointermove and uses the host's 5 ms cursor report instead.
 *
 * `{ forward: false }` makes Electron skip `SetForwardMouseMessages`, so the global
 * WH_MOUSE_LL hook is never installed. The pet page then takes the mouse from the cursor
 * reports the host already sends, at the poll interval patched here (5 ms by default).
 * Once the window is interactive (a drag), Windows still delivers every physical move; the
 * page returns from pointermove at once and the 5 ms report drives the drag, so the page/iframe
 * work stays at display rate instead of the mouse's 2000–8000 Hz.
 *
 * No network, no arbitrary paths: `locateAppRoot` only accepts a directory whose
 * package.json says Coopanion and that contains this one host package.
 */
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';

export const HOST_PACKAGE = 'cortico-world-desktop-pet';
export const PATCH_FILES = [
  { name: 'electron-main.cjs', dir: 'host' },
  { name: 'mouse-lease.cjs', dir: 'host' },
  // The preload is the page's only bridge; the drag APIs are optional for old hosts.
  { name: 'preload.cjs', dir: 'host', optional: true },
  // Best-effort: collapse the page's per-event pointermove work to one per frame. Without it
  // the lag is gone but dragging at 8000 Hz still runs the page/iframe handler 8000 times a
  // second. If a future page rewrites this block, the host patch still applies.
  { name: 'pet-app.js', dir: 'web', optional: true },
  // The figure kit eases the drag position with 28/s; at 8000 Hz that visibly trails the
  // cursor. A tighter ease keeps the pet on the pointer while still smoothing frames.
  { name: 'body.js', dir: 'web/kit', optional: true },
];
export const HOST_FILES = PATCH_FILES.map((file) => file.name);
const FILE_BY_NAME = new Map(PATCH_FILES.map((file) => [file.name, file]));
export const MIN_POLL_MS = 4;
export const MAX_POLL_MS = 100;
export const DEFAULT_POLL_MS = 5;

/** The page's pointermove opening, used both to patch and to recognise the original. */
const PAGE_POINTER_OPEN = /document\.addEventListener\('pointermove', \(e\) => \{\r?\n  pointerSeen = true;/;

/**
 * One replaceable piece per file. The replacement is a function when it depends on pollMs.
 * Patterns are deliberately narrow: a future Coopanion that rewrites these lines must fail
 * loudly and wait for an update of this extension, not be guessed at.
 */
const TARGETS = {
  'electron-main.cjs': [
    {
      id: 'forward',
      pattern: /win\.setIgnoreMouseEvents\(true,\s*\{\s*forward:\s*true\s*\}\);/g,
      replacement: 'win.setIgnoreMouseEvents(true, { forward: false });',
    },
    {
      id: 'timer-resolution',
      pattern: /const CURSOR_EVERY_MS = (\d+);/g,
      replacement: (poll) => [
        '/* __mousefixTimer1ms */',
        'try {',
        "  const winmm = require('koffi').load('winmm.dll');",
        "  const begin = winmm.func('uint32_t __stdcall timeBeginPeriod(uint32_t)');",
        "  const end = winmm.func('uint32_t __stdcall timeEndPeriod(uint32_t)');",
        '  begin(1);',
        "  app.on('will-quit', () => { try { end(1); } catch { /* already gone */ } });",
        '} catch { /* not Windows or koffi missing */ }',
        `const CURSOR_EVERY_MS = ${poll};`,
      ].join('\n'),
    },
    {
      id: 'cursor',
      pattern: /const CURSOR_EVERY_MS = \d+;/g,
      replacement: (pollMs) => `const CURSOR_EVERY_MS = ${pollMs};`,
    },
    {
      id: 'cursor-outside',
      pattern: /const inside = pt\.x >= b\.x && pt\.x < b\.x \+ b\.width && pt\.y >= b\.y && pt\.y < b\.y \+ b\.height;\r?\n      const at = inside \? \{ x: pt\.x - b\.x, y: pt\.y - b\.y \} : null;/g,
      replacement: 'const at = { x: pt.x - b.x, y: pt.y - b.y };',
    },
    {
      id: 'drag-native',
      pattern: /const mouse = createMouseLease\(\{ getWindow: \(\) => win \}\);/g,
      replacement: [
        'const mouse = createMouseLease({ getWindow: () => win });',
        '/* __mousefixDragInput */',
        'let mouseFixDragging = false;',
        'let mouseFixReleaseCapture = null;',
        'const mouseFixButtonDown = (() => {',
        "  if (process.platform !== 'win32') return null;",
        '  try {',
        "    const user32 = require('koffi').load('user32.dll');",
        "    const GetAsyncKeyState = user32.func('int16_t __stdcall GetAsyncKeyState(int)');",
        "    const ReleaseCapture = user32.func('int __stdcall ReleaseCapture()');",
        '    mouseFixReleaseCapture = () => { try { ReleaseCapture(); } catch { /* no capture */ } };',
        '    return () => (GetAsyncKeyState(0x01) & 0x8000) !== 0;',
        '  } catch { return null; }',
        '})();',
      ].join('\n'),
    },
    {
      id: 'drag-start',
      pattern: /onPet\('pet:interactive', \(_e, on\) => mouse\.ask\(on\)\);/g,
      replacement: [
        "  onPet('pet:dragStart', () => {",
        '    if (!win || !mouseFixButtonDown) return;',
        '    mouseFixDragging = true;',
        '    mouse.ask(false);',
        '    if (mouseFixReleaseCapture) mouseFixReleaseCapture();',
        '    win.setIgnoreMouseEvents(true, { forward: false });',
        '  });',
        "  onPet('pet:interactive', (_e, on) => mouse.ask(on));",
      ].join('\n'),
    },
    {
      id: 'drag-cursor',
      pattern: /      const pt = cursor\.read\(\), b = win\.getBounds\(\);\r?\n      const at = \{ x: pt\.x - b\.x, y: pt\.y - b\.y \};\r?\n      win\.webContents\.send\('pet:cursor', at\);\r?\n      mouse\.tick\(\);/g,
      replacement: [
        '      const pt = cursor.read(), b = win.getBounds();',
        '      const at = { x: pt.x - b.x, y: pt.y - b.y };',
        '      if (mouseFixDragging) {',
        '        const down = mouseFixButtonDown ? mouseFixButtonDown() : false;',
        '        at.button = down;',
        '        if (!down) {',
        '          mouseFixDragging = false;',
        "          win.webContents.send('pet:dragEnd');",
        '          mouse.ask(false);',
        '        }',
        '      }',
        "      win.webContents.send('pet:cursor', at);",
        '      mouse.tick();',
        '      if (mouseFixDragging) win.setIgnoreMouseEvents(true, { forward: false });',
      ].join('\n'),
    },
  ],
  'mouse-lease.cjs': [
    {
      id: 'forward',
      pattern: /win\.setIgnoreMouseEvents\(!hold,\s*\{\s*forward:\s*true\s*\}\);/g,
      replacement: 'win.setIgnoreMouseEvents(!hold, { forward: false });',
    },
  ],
  'preload.cjs': [
    {
      id: 'drag-api',
      pattern: /  setInteractive: \(on\) => ipcRenderer\.send\('pet:interactive', !!on\),/g,
      replacement: [
        "  setInteractive: (on) => ipcRenderer.send('pet:interactive', !!on),",
        "  /** Start a click-through drag; the window watches the left button and sends pet:dragEnd. */",
        "  dragStart: () => ipcRenderer.send('pet:dragStart'),",
        "  onDragEnd: (cb) => ipcRenderer.on('pet:dragEnd', () => cb()),",
      ].join('\n'),
    },
  ],
  'pet-app.js': [
    {
      id: 'pointer-open',
      pattern: /document\.addEventListener\('pointermove', \(e\) => \{\r?\n  pointerSeen = true;/g,
      replacement: 'const __mousefixRunPointer = (e) => {\n  pointerSeen = true;',
    },
    {
      id: 'pointer-close',
      pattern: /  followDrag\(p\);\r?\n\}\);/g,
      replacement: [
        '  followDrag(p);',
        '};',
        'let __mousefixPending = null, __mousefixFrame = 0;',
        "document.addEventListener('pointermove', (e) => {",
        '  /* __mousefixCursor180 */',
        '  if (pressing) return;',
        '  __mousefixPending = e;',
        '  if (!__mousefixFrame) __mousefixFrame = requestAnimationFrame(() => {',
        '    __mousefixFrame = 0;',
        '    const ev = __mousefixPending;',
        '    __mousefixPending = null;',
        '    if (ev) __mousefixRunPointer(ev);',
        '  });',
        '});',
      ].join('\n'),
    },
    {
      id: 'pointerdown-clear',
      pattern: /stage\.addEventListener\('pointerdown', \(e\) => \{/g,
      replacement: "stage.addEventListener('pointerdown', (e) => {\n  __mousefixPending = null;\n  __mousefixDragPoint = null;",
    },
    {
      id: 'drag-start-page',
      pattern: /if \(body\?\.hit\(p\)\) \{ pressing = true; stage\.setPointerCapture\(e\.pointerId\); e\.preventDefault\(\); \}/g,
      replacement: 'if (body?.hit(p)) { pressing = true; stage.setPointerCapture(e.pointerId); e.preventDefault(); if (host?.dragStart) { __mousefixNativeDrag = true; host.dragStart(); } }',
    },
    {
      id: 'cursor-sample',
      pattern: /host\?\.onCursor\?\.\(\(p\) => \{\r?\n  cursor\.at = p;/g,
      replacement: [
        'let __mousefixDragPoint = null, __mousefixDragFrame = 0, __mousefixCursorN = 0, __mousefixNativeDrag = false;',
        'host?.onCursor?.((p) => {',
        '  cursor.at = p;',
        '  /* __mousefixDragSample __mousefixDragFrame __mousefixClickThrough */',
        '  __mousefixCursorN++;',
        '  if (!pressing && (__mousefixCursorN % 3)) return;',
        '  if (p) {',
        '    lastPointer.x = p.x; lastPointer.y = p.y;',
        '    if (pressing) {',
        '      if (p.button === false) { up({ clientX: p.x, clientY: p.y }); return; }',
        '      __mousefixDragPoint = p;',
        '      if (!__mousefixDragFrame) __mousefixDragFrame = requestAnimationFrame(() => {',
        '        __mousefixDragFrame = 0;',
        '        const q = __mousefixDragPoint;',
        '        __mousefixDragPoint = null;',
        '        if (q) {',
        "          body?.pointer('move', { x: q.x, y: q.y, t: performance.now() });",
        '          followDrag(q);',
        '        }',
        '      });',
        '      if (!__mousefixNativeDrag) setInteractive(true, \'poll\');',
        '      return;',
        '    }',
        "    body?.pointer('move', { x: p.x, y: p.y, t: performance.now() });",
        '    followDrag(p);',
        '  }',
      ].join('\n'),
    },
    {
      id: 'frame-full',
      pattern: /const full = prefs\.lockFrameRate \|\| !!at\(\)\?\.moving;/g,
      replacement: 'const full = prefs.lockFrameRate || !!at()?.moving || pressing;',
    },
    {
      id: 'pointercancel-guard',
      pattern: /stage\.addEventListener\('pointercancel', up\);/g,
      replacement: "stage.addEventListener('pointercancel', (e) => { if (!__mousefixNativeDrag) up(e); });",
    },
    {
      id: 'drag-end-page',
      pattern: /\/\*\* A press that began on the body and has not been let go of: the window keeps the mouse meanwhile\. \*\//g,
      replacement: [
        "host?.onDragEnd?.(() => { if (pressing) up({ clientX: lastPointer.x, clientY: lastPointer.y }); });",
        '/** A press that began on the body and has not been let go of: the window keeps the mouse meanwhile. */',
      ].join('\n'),
    },
    {
      id: 'leave-clear',
      pattern: /document\.addEventListener\('pointerleave', \(\) => \{ cursor\.at = null;/g,
      replacement: "document.addEventListener('pointerleave', () => { if (pressing) return; __mousefixPending = null; __mousefixDragPoint = null; cursor.at = null;",
    },
    {
      id: 'up-clear',
      pattern: /const up = \(e\) => \{ pressing = false;/g,
      replacement: 'const up = (e) => { __mousefixPending = null; __mousefixDragPoint = null; __mousefixNativeDrag = false; pressing = false;',
    },
  ],
  'body.js': [
    {
      id: 'drag-x',
      pattern: /pet\.dx = lerp\(pet\.dx, pointer\.x, ease\(28, dt\)\);/g,
      replacement: 'pet.dx = lerp(pet.dx, pointer.x, ease(200, dt));',
    },
    {
      id: 'drag-y',
      pattern: /pet\.dy = lerp\(pet\.dy, Math\.min\(pointer\.y, floorY - 245 \* S\), ease\(28, dt\)\);/g,
      replacement: 'pet.dy = lerp(pet.dy, Math.min(pointer.y, floorY - 245 * S), ease(200, dt));',
    },
  ],
};

/** The same pieces after the patch, used to recognise our own work. */
const PATCHED = {
  'electron-main.cjs': {
    forward: /win\.setIgnoreMouseEvents\(true,\s*\{\s*forward:\s*false\s*\}\);/,
    cursor: /const CURSOR_EVERY_MS = (\d+);/,
    outside: /const at = \{ x: pt\.x - b\.x, y: pt\.y - b\.y \};/,
    timer: /__mousefixTimer1ms/,
    dragNative: /__mousefixDragInput/,
    dragStart: /pet:dragStart/,
    dragCursor: /at\.button = down/,
  },
  'mouse-lease.cjs': {
    forward: /win\.setIgnoreMouseEvents\(!hold,\s*\{\s*forward:\s*false\s*\}\);/,
  },
  'pet-app.js': {
    marker: '__mousefixClickThrough',
  },
  'body.js': {
    marker: 'ease(200, dt)',
  },
  'preload.cjs': {
    marker: 'pet:dragStart',
  },
};

/** Clamp a user-supplied poll interval to whole milliseconds in range. */
export function normalisePollMs(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return DEFAULT_POLL_MS;
  return Math.min(MAX_POLL_MS, Math.max(MIN_POLL_MS, Math.round(n)));
}

function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function writeAtomic(file, text) {
  const tmp = `${file}.mousefix-${process.pid}-${Date.now()}.tmp`;
  writeFileSync(tmp, text, 'utf8');
  try {
    renameSync(tmp, file);
  } catch (renameError) {
    // A pet host that is still reading the file can hold it on Windows. Fall back to a direct
    // write, which is still safe here because the whole file is a single small UTF-8 string.
    try {
      writeFileSync(file, text, 'utf8');
    } catch {
      throw renameError;
    }
    try { unlinkSync(tmp); } catch { /* best effort */ }
  }
}

function writeJsonAtomic(file, value) {
  mkdirSync(dirname(file), { recursive: true });
  writeAtomic(file, `${JSON.stringify(value, null, 2)}\n`);
}

function isAppRoot(root) {
  let dir;
  try {
    dir = realpathSync(root);
  } catch {
    return false;
  }
  const pkg = readJson(join(dir, 'package.json'));
  if (pkg?.name !== 'coopanion' && pkg?.productName !== 'Coopanion') return false;
  const host = join(dir, 'node_modules', HOST_PACKAGE, 'host', 'electron-main.cjs');
  try {
    return statSync(host).isFile();
  } catch {
    return false;
  }
}

/**
 * Find the installed Coopanion app directory. The Core's cwd is the app directory when it is
 * spawned by the app; the executable's resources directory covers a Core started elsewhere.
 * Returns `{ root, source }` or `{ error, tried }`.
 */
export function locateAppRoot({ appRoot, cwd = process.cwd(), execPath = process.execPath, platform = process.platform } = {}) {
  const candidates = appRoot
    ? [appRoot]
    : [
      cwd,
      process.env.CORTICO_APP_ROOT,
      join(dirname(execPath), 'resources', 'app'),
      platform === 'darwin' ? join(dirname(execPath), '..', 'Resources', 'app') : null,
    ].filter(Boolean);
  const tried = [];
  for (const candidate of candidates) {
    const root = resolve(candidate);
    tried.push(root);
    if (isAppRoot(root)) return { root: realpathSync(root), source: candidate };
  }
  return { error: `Coopanion app directory not found (tried: ${tried.join(', ')})`, tried };
}

function hostDirOf(appRoot) {
  return join(appRoot, 'node_modules', HOST_PACKAGE, 'host');
}

function filePathOf(appRoot, name) {
  const file = FILE_BY_NAME.get(name);
  return join(appRoot, 'node_modules', HOST_PACKAGE, file.dir, file.name);
}

function versionsOf(appRoot) {
  const app = readJson(join(appRoot, 'package.json'));
  const host = readJson(join(appRoot, 'node_modules', HOST_PACKAGE, 'package.json'));
  return {
    appVersion: typeof app?.version === 'string' ? app.version : null,
    hostVersion: typeof host?.version === 'string' ? host.version : null,
  };
}

/** How a host file looks now: original, our patched form, or something this version does not know. */
export function classify(name, text, pollMs = DEFAULT_POLL_MS) {
  if (name === 'pet-app.js') {
    if (text.includes(PATCHED['pet-app.js'].marker) && text.includes('|| pressing;')) return { state: 'patched' };
    if (text.includes('__mousefixRunPointer') || text.includes('__mousefixDragSample') || text.includes('__mousefixDragFrame') || text.includes('__mousefixPointerDrag')) return { state: 'partial', reason: 'older page wrapper needs the 180 Hz cursor-only drag' };
    if (PAGE_POINTER_OPEN.test(text)) return { state: 'original' };
    return { state: 'unsupported', reason: 'pointermove block not found' };
  }
  if (name === 'body.js') {
    if (text.includes(PATCHED['body.js'].marker)) return { state: 'patched' };
    if (text.includes('ease(28, dt)')) return { state: 'original' };
    return { state: 'unsupported', reason: 'drag easing line not found' };
  }
  if (name === 'preload.cjs') {
    if (text.includes(PATCHED['preload.cjs'].marker)) return { state: 'patched' };
    if (text.includes("setInteractive: (on) => ipcRenderer.send('pet:interactive', !!on)")) return { state: 'original' };
    return { state: 'unsupported', reason: 'setInteractive bridge not found' };
  }
  const spec = PATCHED[name];
  if (!spec) return { state: 'unsupported', reason: `unknown host file ${name}` };
  const forward = spec.forward.test(text);
  const cursor = spec.cursor ? spec.cursor.exec(text) : null;
  const cursorMs = cursor ? Number(cursor[1]) : null;
  const original = name === 'electron-main.cjs'
    ? /win\.setIgnoreMouseEvents\(true,\s*\{\s*forward:\s*true\s*\}\);/.test(text)
    : /win\.setIgnoreMouseEvents\(!hold,\s*\{\s*forward:\s*true\s*\}\);/.test(text);

  if (forward && original) return { state: 'unknown', reason: 'both forwarded and non-forwarded calls found' };
  if (original) return { state: 'original', forward: false, cursorMs };
  if (!forward) return { state: 'unsupported', reason: 'expected setIgnoreMouseEvents call not found' };
  if (name === 'electron-main.cjs' && cursorMs === null) return { state: 'unsupported', reason: 'CURSOR_EVERY_MS not found' };
  if (name === 'electron-main.cjs' && cursorMs !== pollMs) return { state: 'partial', forward: true, cursorMs };
  if (name === 'electron-main.cjs' && !spec.outside.test(text)) return { state: 'partial', forward: true, cursorMs, reason: 'cursor report outside the window is not patched' };
  if (name === 'electron-main.cjs' && !spec.timer.test(text)) return { state: 'partial', forward: true, cursorMs, reason: 'Windows timer resolution is not raised' };
  if (name === 'electron-main.cjs' && (!spec.dragNative.test(text) || !spec.dragStart.test(text) || !spec.dragCursor.test(text))) return { state: 'partial', forward: true, cursorMs, reason: 'click-through drag input is not patched' };
  return { state: 'patched', forward: true, cursorMs };
}

function statePathOf(dataDir) {
  return join(dataDir, 'mouse-polling-fix', 'state.json');
}

function backupRootOf(dataDir) {
  return join(dataDir, 'mouse-polling-fix', 'backups');
}

function writeBackup(backupRoot, name, text) {
  const hash = sha256(text);
  const dir = join(backupRoot, hash);
  const file = join(dir, name);
  mkdirSync(dir, { recursive: true });
  if (!existsSync(file)) writeFileSync(file, text, 'utf8');
  return file;
}

function readText(file) {
  try {
    return readFileSync(file, 'utf8');
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Inspect without writing. `dataDir` is the Coopanion data directory that holds state and
 * backups; it defaults to the app directory's sibling `data` for standalone use.
 */
export function inspect({ appRoot, dataDir, pollMs = DEFAULT_POLL_MS } = {}) {
  const located = locateAppRoot({ appRoot });
  if (located.error) return { ok: false, error: located.error, tried: located.tried };
  const root = located.root;
  const data = dataDir ?? join(dirname(root), 'data');
  const wanted = normalisePollMs(pollMs);
  const hostDir = hostDirOf(root);
  const statePath = statePathOf(data);
  const state = readJson(statePath) ?? {};
  const files = [];
  let supported = true;
  let patched = true;
  for (const file of PATCH_FILES) {
    const name = file.name;
    const path = filePathOf(root, name);
    const text = readText(path);
    if (typeof text !== 'string') {
      files.push({ name, path, state: file.optional ? 'skipped' : 'missing', error: text.error, backupPath: state.files?.[name]?.backupPath ?? null });
      if (!file.optional) {
        supported = false;
        patched = false;
      }
      continue;
    }
    const now = classify(name, text, wanted);
    const backupPath = state.files?.[name]?.backupPath ?? null;
    const backupExists = !!backupPath && existsSync(backupPath);
    if (file.optional && (now.state === 'unsupported' || now.state === 'unknown')) {
      files.push({ name, path, ...now, state: 'skipped', backupPath, backupExists });
      continue;
    }
    files.push({ name, path, ...now, backupPath, backupExists });
    if (!file.optional) {
      if (now.state === 'unsupported' || now.state === 'unknown' || now.state === 'missing') supported = false;
      if (now.state !== 'patched') patched = false;
    }
  }
  return {
    ok: true,
    appRoot: root,
    source: located.source,
    ...versionsOf(root),
    hostDir,
    dataDir: data,
    statePath,
    pollMs: wanted,
    supported,
    patched,
    files,
    state,
    error: null,
  };
}

/**
 * Apply the patch. Returns `{ ok, changed, ...inspect }`; on a partial failure it leaves
 * untouched files as they are and reports which file refused. Backups are written before
 * the first byte changes and never overwritten.
 */
export function apply({ appRoot, dataDir, pollMs = DEFAULT_POLL_MS, logger = null } = {}) {
  const wanted = normalisePollMs(pollMs);
  const before = inspect({ appRoot, dataDir, pollMs: wanted });
  if (!before.ok) return { ...before, changed: false };
  const { appRoot: root, dataDir: data } = before;
  // Never touch the app before there is somewhere to record the backup and the hashes: an
  // unrecorded patch would have no safe restore path.
  const stateDir = join(data, 'mouse-polling-fix');
  try {
    mkdirSync(stateDir, { recursive: true });
    const probe = join(stateDir, `.write-test-${process.pid}`);
    writeFileSync(probe, '');
    unlinkSync(probe);
  } catch (err) {
    return {
      ...before,
      ok: false,
      changed: false,
      error: `Coopanion data directory is not writable (${stateDir}): ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  const backupRoot = backupRootOf(data);
  const statePath = statePathOf(data);
  const state = readJson(statePath) ?? {};
  const files = {};
  let changed = false;
  let ok = true;
  let error = null;

  for (const file of PATCH_FILES) {
    const name = file.name;
    const path = filePathOf(root, name);
    let text = readText(path);
    if (typeof text !== 'string') {
      if (file.optional) {
        files[name] = { ...(state.files?.[name] ?? {}), state: 'skipped', error: text.error };
        continue;
      }
      ok = false;
      files[name] = { ...(state.files?.[name] ?? {}), state: 'missing', error: text.error };
      error ??= `${name}: ${text.error}`;
      continue;
    }
    let now = classify(name, text, wanted);
    // 0.1.1 wrapped the page handler but still consumed every pointermove during a drag.
    // Put the recorded original back first, then lay the 0.1.3 page on top of it.
    if (name === 'pet-app.js' && now.state === 'partial') {
      const recorded = state.files?.[name]?.backupPath;
      const original = recorded && existsSync(recorded) ? readText(recorded) : { error: 'no original backup for the 0.1.1 page wrapper' };
      if (typeof original !== 'string') {
        if (file.optional) {
          files[name] = { ...(state.files?.[name] ?? {}), ...now, state: 'skipped', error: original.error };
          continue;
        }
        ok = false;
        files[name] = { ...(state.files?.[name] ?? {}), ...now, error: original.error };
        error ??= `${name}: ${original.error}`;
        continue;
      }
      text = original;
      now = classify(name, text, wanted);
    }
    if (now.state === 'patched') {
      files[name] = { ...(state.files?.[name] ?? {}), ...now };
      continue;
    }
    if (now.state !== 'original' && now.state !== 'partial') {
      if (file.optional) {
        files[name] = { ...(state.files?.[name] ?? {}), ...now, state: 'skipped' };
        continue;
      }
      ok = false;
      files[name] = { ...(state.files?.[name] ?? {}), ...now };
      error ??= `${name}: ${now.reason ?? now.state}`;
      continue;
    }

    let backupPath = state.files?.[name]?.backupPath ?? null;
    if (now.state === 'original') {
      // A new app version is a new original: take a fresh backup and update the record.
      try {
        backupPath = writeBackup(backupRoot, name, text);
      } catch (err) {
        if (file.optional) {
          files[name] = { ...(state.files?.[name] ?? {}), ...now, state: 'skipped', error: `backup failed: ${err instanceof Error ? err.message : String(err)}` };
          continue;
        }
        ok = false;
        files[name] = { ...(state.files?.[name] ?? {}), ...now, error: `backup failed: ${err instanceof Error ? err.message : String(err)}` };
        error ??= `${name}: backup failed: ${err instanceof Error ? err.message : String(err)}`;
        continue;
      }
    } else if (!backupPath || !existsSync(backupPath) || !state.files?.[name]?.originalHash) {
      if (file.optional) {
        files[name] = { ...(state.files?.[name] ?? {}), ...now, state: 'skipped', error: 'partially patched and no complete backup record' };
        continue;
      }
      ok = false;
      files[name] = { ...(state.files?.[name] ?? {}), ...now, error: 'partially patched and no complete backup record' };
      error ??= `${name}: partially patched and no complete backup record`;
      continue;
    }

    let next = text;
    let fileError = null;
    for (const spec of TARGETS[name]) {
      // A file already on `forward: false` but with the wrong cursor interval only needs the
      // interval line; the forward line has nothing left to replace.
      if (now.state === 'partial' && spec.id === 'forward') continue;
      // The outside-window report is an all-or-nothing line; skip it when it is already there.
      if (spec.id === 'cursor-outside' && PATCHED['electron-main.cjs'].outside.test(next)) continue;
      // Re-applying a different poll interval must not stack timeBeginPeriod blocks.
      if (spec.id === 'timer-resolution' && PATCHED['electron-main.cjs'].timer.test(next)) continue;
      // The click-through drag block is all-or-nothing; skip each piece when already present.
      if (spec.id === 'drag-native' && PATCHED['electron-main.cjs'].dragNative.test(next)) continue;
      if (spec.id === 'drag-start' && PATCHED['electron-main.cjs'].dragStart.test(next)) continue;
      if (spec.id === 'drag-cursor' && PATCHED['electron-main.cjs'].dragCursor.test(next)) continue;
      const matches = next.match(spec.pattern);
      if (!matches) {
        // The cursor line is optional only for a file that never had it; every spec is required here.
        fileError = `expected ${spec.id} line not found`;
        break;
      }
      if (matches.length !== 1) {
        fileError = `expected exactly one ${spec.id} line, found ${matches.length}`;
        break;
      }
      const replacement = typeof spec.replacement === 'function' ? spec.replacement(wanted) : spec.replacement;
      next = next.replace(spec.pattern, replacement);
    }
    if (fileError) {
      if (file.optional) {
        files[name] = { ...(state.files?.[name] ?? {}), ...now, state: 'skipped', error: fileError, backupPath };
        continue;
      }
      ok = false;
      files[name] = { ...(state.files?.[name] ?? {}), ...now, error: fileError, backupPath };
      error ??= `${name}: ${fileError}`;
      continue;
    }
    const after = classify(name, next, wanted);
    if (after.state !== 'patched') {
      if (file.optional) {
        files[name] = { ...(state.files?.[name] ?? {}), ...after, state: 'skipped', error: `patch result is ${after.state}`, backupPath };
        continue;
      }
      ok = false;
      files[name] = { ...(state.files?.[name] ?? {}), ...after, error: `patch result is ${after.state}`, backupPath };
      error ??= `${name}: patch result is ${after.state}`;
      continue;
    }
    try {
      writeAtomic(path, next);
    } catch (err) {
      if (file.optional) {
        files[name] = { ...(state.files?.[name] ?? {}), ...now, state: 'skipped', error: err instanceof Error ? err.message : String(err), backupPath };
        continue;
      }
      ok = false;
      files[name] = { ...(state.files?.[name] ?? {}), ...now, error: err instanceof Error ? err.message : String(err), backupPath };
      error ??= `${name}: ${err instanceof Error ? err.message : String(err)}`;
      continue;
    }
    changed = true;
    files[name] = {
      ...(state.files?.[name] ?? {}),
      ...after,
      backupPath,
      // A partial file is already pieced together from an earlier original; keep that original's
      // hash instead of hashing the partially patched bytes.
      originalHash: now.state === 'original' ? sha256(text) : (state.files?.[name]?.originalHash ?? null),
      patchedHash: sha256(next),
      patchedAt: new Date().toISOString(),
    };
    logger?.info?.(`已打补丁 ${name}`);
  }

  const nextState = {
    ...state,
    appRoot: root,
    ...versionsOf(root),
    pollMs: wanted,
    files,
    updatedAt: new Date().toISOString(),
    error,
  };
  try {
    writeJsonAtomic(statePath, nextState);
  } catch (err) {
    ok = false;
    error ??= `could not write ${statePath}: ${err instanceof Error ? err.message : String(err)}`;
  }
  const after = inspect({ appRoot: root, dataDir: data, pollMs: wanted });
  return { ...after, ok: ok && after.ok, changed, error };
}

/**
 * Restore the exact bytes this extension backed up. Refuses when a host file is neither the
 * patched nor the original form, so a Coopanion update or a manual edit is never overwritten
 * silently.
 */
export function restore({ appRoot, dataDir, logger = null } = {}) {
  const now = inspect({ appRoot, dataDir });
  if (!now.ok) return { ...now, restored: [] };
  const state = readJson(now.statePath) ?? {};
  const restored = [];
  let ok = true;
  let error = null;
  for (const file of PATCH_FILES) {
    const name = file.name;
    const path = filePathOf(now.appRoot, name);
    const text = readText(path);
    if (typeof text !== 'string') {
      if (file.optional) continue;
      ok = false;
      error ??= `${name}: ${text.error}`;
      continue;
    }
    const record = state.files?.[name] ?? {};
    let current = classify(name, text, normalisePollMs(state.pollMs ?? DEFAULT_POLL_MS));
    // A manually changed interval is still our patched forward line; the byte hash below is the
    // authority on whether this is exactly the file we wrote.
    if (current.state === 'partial') current = classify(name, text, current.cursorMs);
    if (current.state === 'original') {
      restored.push(name);
      continue;
    }
    if (current.state !== 'patched') {
      if (file.optional) continue;
      ok = false;
      error ??= `${name}: current file is ${current.state}; refusing to overwrite`;
      continue;
    }
    const backupPath = record.backupPath;
    if (!backupPath || !existsSync(backupPath)) {
      if (file.optional) continue;
      ok = false;
      error ??= `${name}: no backup recorded`;
      continue;
    }
    const backup = readText(backupPath);
    if (typeof backup !== 'string') {
      ok = false;
      error ??= `${name}: backup unreadable`;
      continue;
    }
    if (record.originalHash && sha256(backup) !== record.originalHash) {
      ok = false;
      error ??= `${name}: backup hash does not match the recorded original`;
      continue;
    }
    const hash = sha256(text);
    if (!record.patchedHash) {
      ok = false;
      error ??= `${name}: state has no patched hash; refusing to overwrite`;
      continue;
    }
    if (hash !== record.patchedHash) {
      ok = false;
      error ??= `${name}: current file is not the patched file this extension wrote (update or manual edit); refused`;
      continue;
    }
    try {
      writeAtomic(path, backup);
      restored.push(name);
      logger?.info?.(`已还原 ${name}`);
    } catch (err) {
      ok = false;
      error ??= `${name}: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
  try {
    writeJsonAtomic(now.statePath, {
      ...state,
      appRoot: now.appRoot,
      appVersion: now.appVersion,
      hostVersion: now.hostVersion,
      files: state.files ?? {},
      restoredAt: new Date().toISOString(),
      error,
    });
  } catch (err) {
    ok = false;
    error ??= `could not write ${now.statePath}: ${err instanceof Error ? err.message : String(err)}`;
  }
  return { ok, error, restored, ...now };
}
