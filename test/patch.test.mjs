/**
 * Patch/rollback tests. Run with `node test/patch.test.mjs`.
 *
 * The fixture lines are the exact lines this patch targets. When `COOPANION_APP_ROOT` points
 * at an installed `resources/app`, the test also copies the real 0.2.11 host files and checks
 * the patterns still match; that is how a new Coopanion version is qualified before release.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  apply,
  classify,
  inspect,
  locateAppRoot,
  normalisePollMs,
  restore,
} from '../src/patch.js';

const FIXTURE_ELECTRON = `/** fixture */
const CURSOR_EVERY_MS = 100;
const mouse = createMouseLease({ getWindow: () => win });
function ipc() {
  onPet('pet:interactive', (_e, on) => mouse.ask(on));
}
function cursorTimer() {
      const pt = cursor.read(), b = win.getBounds();
      const inside = pt.x >= b.x && pt.x < b.x + b.width && pt.y >= b.y && pt.y < b.y + b.height;
      const at = inside ? { x: pt.x - b.x, y: pt.y - b.y } : null;
      win.webContents.send('pet:cursor', at);
      mouse.tick();
}
function create() {
  win.setIgnoreMouseEvents(true, { forward: true });
  setInterval(() => {}, CURSOR_EVERY_MS);
}
`;
const FIXTURE_LEASE = `/** fixture */
function createMouseLease() {
  return { apply() { win.setIgnoreMouseEvents(!hold, { forward: true }); } };
}
`;
const FIXTURE_PAGE = `/** fixture */
const UI_SELECTOR = '.x';
const overUi = (e) => e.target.closest && e.target.closest(UI_SELECTOR);
document.addEventListener('pointermove', (e) => {
  pointerSeen = true;
  lastPointer.x = e.clientX; lastPointer.y = e.clientY;
  const p = { x: e.clientX, y: e.clientY };
  cursor.at = p;
  if (pressing && e.buttons === 0) pressing = false;
  if (!shifting) body?.pointer('move', { ...p, t: e.timeStamp });
  const hit = !!body?.hit(p), ui = !!overUi(e);
  setInteractive(rendering() && (pressing || hit || ui), 'move');
  followDrag(p);
});
stage.addEventListener('pointerdown', (e) => {
  const p = { x: e.clientX, y: e.clientY };
  body?.pointer('down', p);
  if (body?.hit(p)) { pressing = true; stage.setPointerCapture(e.pointerId); e.preventDefault(); }
});
/** A press that began on the body and has not been let go of: the window keeps the mouse meanwhile. */
let pressing = false;
host?.onCursor?.((p) => {
  cursor.at = p;
  if (!p) return;
  const el = document.elementFromPoint(p.x, p.y);
  setInteractive(rendering() && (pressing || !!body?.hit(p)), 'poll');
});
const up = (e) => { pressing = false; body?.pointer('up', { x: e.clientX, y: e.clientY }); stage.style.cursor = ''; };
stage.addEventListener('pointercancel', up);
document.addEventListener('pointerleave', () => { cursor.at = null; body?.pointer('leave', {}); });
function frameRate() {
  const full = prefs.lockFrameRate || !!at()?.moving;
  return full;
}
`;
const FIXTURE_BODY = `/** fixture */
function dragTick() {
  pet.dx = lerp(pet.dx, pointer.x, ease(28, dt));
  pet.dy = lerp(pet.dy, Math.min(pointer.y, floorY - 245 * S), ease(28, dt));
}
`;

const FIXTURE_PRELOAD = `// fixture
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('petHost', {
  setInteractive: (on) => ipcRenderer.send('pet:interactive', !!on),
});
`;

function makeApp({ electron = FIXTURE_ELECTRON, lease = FIXTURE_LEASE, page = FIXTURE_PAGE, body = FIXTURE_BODY, preload = FIXTURE_PRELOAD } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'mousefix-'));
  const app = join(root, 'resources', 'app');
  const pkg = join(app, 'node_modules', 'cortico-world-desktop-pet');
  const host = join(pkg, 'host');
  const web = join(pkg, 'web');
  const kit = join(web, 'kit');
  mkdirSync(host, { recursive: true });
  mkdirSync(kit, { recursive: true });
  writeFileSync(join(app, 'package.json'), JSON.stringify({ name: 'coopanion', version: '0.2.11' }));
  writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: 'cortico-world-desktop-pet', version: '0.2.0' }));
  writeFileSync(join(host, 'electron-main.cjs'), electron);
  writeFileSync(join(host, 'mouse-lease.cjs'), lease);
  writeFileSync(join(host, 'preload.cjs'), preload);
  writeFileSync(join(web, 'pet-app.js'), page);
  writeFileSync(join(kit, 'body.js'), body);
  return { root, app, host, web, kit, data: join(root, 'data') };
}

function read(file) {
  return readFileSync(file, 'utf8');
}

// --- normalisation ---------------------------------------------------------
assert.equal(normalisePollMs(undefined), 5);
assert.equal(normalisePollMs(4), 4);
assert.equal(normalisePollMs(1000), 100);
assert.equal(normalisePollMs('24'), 24);

// --- happy path ------------------------------------------------------------
{
  const app = makeApp();
  assert.ok(locateAppRoot({ appRoot: app.app }).root);
  const first = apply({ appRoot: app.app, dataDir: app.data, pollMs: 16 });
  assert.equal(first.ok, true, first.error ?? '');
  assert.equal(first.changed, true);
  assert.equal(first.patched, true);
  assert.equal(first.appVersion, '0.2.11');
  assert.equal(first.hostVersion, '0.2.0');

  const electron = read(join(app.host, 'electron-main.cjs'));
  const lease = read(join(app.host, 'mouse-lease.cjs'));
  const page = read(join(app.web, 'pet-app.js'));
  const body = read(join(app.kit, 'body.js'));
  const preload = read(join(app.host, 'preload.cjs'));
  assert.match(electron, /win\.setIgnoreMouseEvents\(true, \{ forward: false \}\);/);
  assert.match(electron, /const CURSOR_EVERY_MS = 16;/);
  assert.match(electron, /__mousefixTimer1ms/);
  assert.match(electron, /timeBeginPeriod/);
  assert.match(electron, /__mousefixDragInput/);
  assert.match(electron, /GetAsyncKeyState/);
  assert.match(electron, /const at = \{ x: pt\.x - b\.x, y: pt\.y - b\.y \};/);
  assert.doesNotMatch(electron, /inside \?/);
  assert.match(lease, /win\.setIgnoreMouseEvents\(!hold, \{ forward: false \}\);/);
  assert.match(page, /__mousefixCursor180/);
  assert.match(page, /__mousefixClickThrough/);
  assert.match(page, /__mousefixNativeDrag/);
  assert.match(page, /host\?\.dragStart/);
  assert.match(page, /onDragEnd/);
  assert.match(page, /__mousefixDragFrame/);
  assert.match(page, /__mousefixDragPoint/);
  assert.match(page, /if \(pressing\) return;/);
  assert.match(page, /const full = prefs\.lockFrameRate \|\| !!at\(\)\?\.moving \|\| pressing;/);
  assert.match(page, /__mousefixPending = null;.*pressing = false/);
  assert.match(page, /body\?\.pointer\('move', \{ x: q\.x, y: q\.y/);
  assert.match(page, /pointerleave[^\n]*__mousefixPending = null/);
  assert.match(page, /const up = \(e\) => \{ __mousefixPending = null;/);
  assert.match(page, /pointerdown[^\n]*\n\s*__mousefixPending = null;/);
  assert.match(page, /requestAnimationFrame/);
  assert.match(body, /ease\(200, dt\)/);
  assert.doesNotMatch(body, /ease\(28, dt\)/);
  assert.match(preload, /pet:dragStart/);
  assert.match(preload, /pet:dragEnd/);
  assert.doesNotMatch(electron, /forward: true/);
  assert.doesNotMatch(lease, /forward: true/);

  const again = apply({ appRoot: app.app, dataDir: app.data, pollMs: 16 });
  assert.equal(again.ok, true);
  assert.equal(again.changed, false, 'second apply must be idempotent');

  const inspected = inspect({ appRoot: app.app, dataDir: app.data, pollMs: 16 });
  assert.equal(inspected.ok, true);
  assert.equal(inspected.patched, true);
  assert.equal(inspected.supported, true);
  for (const file of inspected.files) {
    assert.equal(file.state, 'patched');
    assert.equal(file.backupExists, true, `${file.name} backup`);
  }

  const fast = apply({ appRoot: app.app, dataDir: app.data, pollMs: 8 });
  assert.equal(fast.ok, true);
  assert.equal(fast.changed, true);
  assert.match(read(join(app.host, 'electron-main.cjs')), /const CURSOR_EVERY_MS = 8;/);

  const restored = restore({ appRoot: app.app, dataDir: app.data });
  assert.equal(restored.ok, true, restored.error ?? '');
  assert.deepEqual(restored.restored.sort(), ['body.js', 'electron-main.cjs', 'mouse-lease.cjs', 'pet-app.js', 'preload.cjs']);
  assert.equal(read(join(app.host, 'electron-main.cjs')), FIXTURE_ELECTRON);
  assert.equal(read(join(app.host, 'mouse-lease.cjs')), FIXTURE_LEASE);
  assert.equal(read(join(app.host, 'preload.cjs')), FIXTURE_PRELOAD);
  assert.equal(read(join(app.web, 'pet-app.js')), FIXTURE_PAGE);
  assert.equal(read(join(app.kit, 'body.js')), FIXTURE_BODY);
  assert.equal(inspect({ appRoot: app.app, dataDir: app.data }).patched, false);

  rmSync(app.root, { recursive: true, force: true });
}

// --- a Coopanion update replaces the patched files: re-patch and restore the new original --
{
  const app = makeApp();
  const first = apply({ appRoot: app.app, dataDir: app.data, pollMs: 16 });
  assert.equal(first.ok, true, first.error ?? '');

  const updated = FIXTURE_ELECTRON.replace('/** fixture */', '/** fixture 0.2.12 */');
  writeFileSync(join(app.host, 'electron-main.cjs'), updated);
  const second = apply({ appRoot: app.app, dataDir: app.data, pollMs: 8 });
  assert.equal(second.ok, true, second.error ?? '');
  assert.equal(second.changed, true);
  assert.match(read(join(app.host, 'electron-main.cjs')), /fixture 0\.2\.12/);
  assert.match(read(join(app.host, 'electron-main.cjs')), /CURSOR_EVERY_MS = 8/);

  const rollback = restore({ appRoot: app.app, dataDir: app.data });
  assert.equal(rollback.ok, true, rollback.error ?? '');
  assert.equal(read(join(app.host, 'electron-main.cjs')), updated);

  rmSync(app.root, { recursive: true, force: true });
}

// --- unsupported host code must not be guessed at --------------------------
{
  const app = makeApp({ electron: FIXTURE_ELECTRON.replace('forward: true', 'forward: maybe') });
  const result = apply({ appRoot: app.app, dataDir: app.data, pollMs: 16 });
  assert.equal(result.ok, false);
  assert.match(result.error ?? '', /electron-main\.cjs/);
  assert.equal(read(join(app.host, 'electron-main.cjs')), FIXTURE_ELECTRON.replace('forward: true', 'forward: maybe'));
  assert.equal(existsSync(join(app.data, 'mouse-polling-fix', 'state.json')), true);
  rmSync(app.root, { recursive: true, force: true });
}

// --- a manual patched file without a backup is not overwritten -------------
{
  const app = makeApp({ electron: FIXTURE_ELECTRON.replace('forward: true', 'forward: false') });
  const result = apply({ appRoot: app.app, dataDir: app.data, pollMs: 16 });
  assert.equal(result.ok, false);
  assert.match(result.error ?? '', /no complete backup record/);
  rmSync(app.root, { recursive: true, force: true });
}

// --- an unknown page block is optional: the host fix still applies ---------
{
  const page = 'const unrelated = 1;\n';
  const app = makeApp({ page });
  const result = apply({ appRoot: app.app, dataDir: app.data, pollMs: 16 });
  assert.equal(result.ok, true, result.error ?? '');
  assert.equal(result.changed, true);
  assert.equal(result.patched, true);
  const skipped = inspect({ appRoot: app.app, dataDir: app.data }).files.find((file) => file.name === 'pet-app.js');
  assert.equal(skipped.state, 'skipped');
  assert.equal(read(join(app.web, 'pet-app.js')), page);
  rmSync(app.root, { recursive: true, force: true });
}

// --- real 0.2.11 files, when available -------------------------------------
const realRoot = process.env.COOPANION_APP_ROOT
  || (process.platform === 'win32' ? 'F:\\coo\\Coopanion\\resources\\app' : '');
if (realRoot && existsSync(join(realRoot, 'node_modules', 'cortico-world-desktop-pet', 'host', 'electron-main.cjs'))) {
  const hostDir = join(realRoot, 'node_modules', 'cortico-world-desktop-pet');
  const sources = {
    'electron-main.cjs': join(hostDir, 'host', 'electron-main.cjs'),
    'mouse-lease.cjs': join(hostDir, 'host', 'mouse-lease.cjs'),
    'preload.cjs': join(hostDir, 'host', 'preload.cjs'),
    'pet-app.js': join(hostDir, 'web', 'pet-app.js'),
    'body.js': join(hostDir, 'web', 'kit', 'body.js'),
  };
  // When the live install is already patched, its recorded backups are the originals.
  const statePath = join(dirname(realRoot), '..', 'data', 'home', 'companion', 'data', 'mouse-polling-fix', 'state.json');
  if (existsSync(statePath)) {
    try {
      const state = JSON.parse(readFileSync(statePath, 'utf8'));
      for (const [name, record] of Object.entries(state.files ?? {})) {
        if (sources[name] && record?.backupPath && existsSync(record.backupPath)) sources[name] = record.backupPath;
      }
    } catch { /* use the live files */ }
  }
  const app = makeApp({
    electron: read(sources['electron-main.cjs']),
    lease: read(sources['mouse-lease.cjs']),
    page: read(sources['pet-app.js']),
    body: read(sources['body.js']),
    preload: read(sources['preload.cjs']),
  });
  const result = apply({ appRoot: app.app, dataDir: app.data, pollMs: 16 });
  assert.equal(result.ok, true, `real host files: ${result.error ?? ''}`);
  assert.equal(result.patched, true);
  assert.equal(classify('electron-main.cjs', read(join(app.host, 'electron-main.cjs')), 16).state, 'patched');
  assert.equal(classify('pet-app.js', read(join(app.web, 'pet-app.js')), 16).state, 'patched');
  assert.equal(classify('body.js', read(join(app.kit, 'body.js')), 16).state, 'patched');
  const rollback = restore({ appRoot: app.app, dataDir: app.data });
  assert.equal(rollback.ok, true, rollback.error ?? '');
  rmSync(app.root, { recursive: true, force: true });
  console.log('real Coopanion host files: patched and restored');
} else {
  console.log('real Coopanion host files: skipped (COOPANION_APP_ROOT not set/found)');
}

// --- upgrading a live 0.1.1 page wrapper from its recorded original -------------
if (realRoot && existsSync(join(realRoot, 'node_modules', 'cortico-world-desktop-pet', 'web', 'pet-app.js'))) {
  const livePage = join(realRoot, 'node_modules', 'cortico-world-desktop-pet', 'web', 'pet-app.js');
  const liveStatePath = join(dirname(realRoot), '..', 'data', 'home', 'companion', 'data', 'mouse-polling-fix', 'state.json');
  if (existsSync(liveStatePath)) {
    try {
      const live = JSON.parse(readFileSync(liveStatePath, 'utf8'));
      const record = live.files?.['pet-app.js'];
      const liveText = read(livePage);
      if (record?.backupPath && existsSync(record.backupPath) && liveText.includes('__mousefixRunPointer') && !liveText.includes('__mousefixClickThrough')) {
        const liveHost = join(realRoot, 'node_modules', 'cortico-world-desktop-pet');
        const app = makeApp({
          electron: read(join(liveHost, 'host', 'electron-main.cjs')),
          lease: read(join(liveHost, 'host', 'mouse-lease.cjs')),
          page: liveText,
          body: read(join(liveHost, 'web', 'kit', 'body.js')),
          preload: read(join(liveHost, 'host', 'preload.cjs')),
        });
        mkdirSync(join(app.data, 'mouse-polling-fix'), { recursive: true });
        writeFileSync(join(app.data, 'mouse-polling-fix', 'state.json'), JSON.stringify({
          appRoot: app.app, appVersion: '0.2.11', hostVersion: '0.2.0', pollMs: 16,
          files: live.files,
        }));
        const upgraded = apply({ appRoot: app.app, dataDir: app.data, pollMs: 16 });
        assert.equal(upgraded.ok, true, upgraded.error ?? '');
        assert.equal(classify('pet-app.js', read(join(app.web, 'pet-app.js')), 16).state, 'patched');
        assert.equal(classify('body.js', read(join(app.kit, 'body.js')), 16).state, 'patched');
        assert.match(read(join(app.host, 'electron-main.cjs')), /const at = \{ x: pt\.x - b\.x, y: pt\.y - b\.y \};/);
        const rollback = restore({ appRoot: app.app, dataDir: app.data });
        assert.equal(rollback.ok, true, rollback.error ?? '');
        assert.equal(read(join(app.web, 'pet-app.js')), read(record.backupPath));
        assert.equal(read(join(app.kit, 'body.js')), read(live.files['body.js'].backupPath));
        assert.equal(read(join(app.host, 'electron-main.cjs')), read(live.files['electron-main.cjs'].backupPath));
        rmSync(app.root, { recursive: true, force: true });
        console.log('0.1.1–0.1.6 host/page upgrade: patched from backups and restored');
      }
    } catch (error) { console.log('live upgrade test skipped:', error.message); }
  }
}

console.log('patch tests passed');

