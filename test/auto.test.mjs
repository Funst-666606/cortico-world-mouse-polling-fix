/**
 * The auto-apply path: inside Coopanion, create() must patch before any World starts.
 * This test fakes the Coopanion environment and app directory, then calls the real World.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.COOPANION_VERSION = '0.2.11';
process.env.CORTICO_SUPERVISED = '1';

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

const root = mkdtempSync(join(tmpdir(), 'mousefix-auto-'));
const app = join(root, 'resources', 'app');
const pkg = join(app, 'node_modules', 'cortico-world-desktop-pet');
const host = join(pkg, 'host');
const web = join(pkg, 'web');
const kit = join(web, 'kit');
mkdirSync(host, { recursive: true });
mkdirSync(kit, { recursive: true });
writeFileSync(join(app, 'package.json'), JSON.stringify({ name: 'coopanion', version: '0.2.11' }));
writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: 'cortico-world-desktop-pet', version: '0.2.0' }));
writeFileSync(join(host, 'electron-main.cjs'), FIXTURE_ELECTRON);
writeFileSync(join(host, 'mouse-lease.cjs'), FIXTURE_LEASE);
writeFileSync(join(host, 'preload.cjs'), FIXTURE_PRELOAD);
writeFileSync(join(web, 'pet-app.js'), FIXTURE_PAGE);
writeFileSync(join(kit, 'body.js'), FIXTURE_BODY);

const previousCwd = process.cwd();
process.chdir(app);
const { default: definition } = await import('../src/index.js');

const ctx = {
  id: definition.id,
  cfg: { enabled: true, pollMs: 16, autoApply: true },
  timezone: 'Asia/Taipei',
  botName: 'test',
  botDir: root,
  packageDir: root,
  dataDir: join(root, 'data'),
  repoRoot: app,
  secret: () => '',
  storeSecret() {},
  persist() {},
  restart: async () => {},
};

const world = definition.create(ctx);
assert.match(readFileSync(join(host, 'electron-main.cjs'), 'utf8'), /forward: false/);
assert.match(readFileSync(join(host, 'electron-main.cjs'), 'utf8'), /CURSOR_EVERY_MS = 16/);
assert.match(readFileSync(join(host, 'electron-main.cjs'), 'utf8'), /timeBeginPeriod/);
assert.match(readFileSync(join(host, 'electron-main.cjs'), 'utf8'), /GetAsyncKeyState/);
assert.match(readFileSync(join(host, 'mouse-lease.cjs'), 'utf8'), /forward: false/);
assert.match(readFileSync(join(web, 'pet-app.js'), 'utf8'), /__mousefixCursor180/);
assert.match(readFileSync(join(web, 'pet-app.js'), 'utf8'), /__mousefixClickThrough/);
assert.match(readFileSync(join(web, 'pet-app.js'), 'utf8'), /__mousefixNativeDrag/);
assert.match(readFileSync(join(host, 'preload.cjs'), 'utf8'), /pet:dragStart/);
assert.match(readFileSync(join(web, 'pet-app.js'), 'utf8'), /\|\| pressing;/);
assert.match(readFileSync(join(kit, 'body.js'), 'utf8'), /ease\(200, dt\)/);

const status = world.tools().find((tool) => tool.name === 'mouse_fix_status');
const statusText = await status.handler({}, {});
assert.match(statusText, /patched/);
assert.match(statusText, /0\.2\.11/);

await world.start({ log: { info() {}, warn() {}, debug() {} } });
const restore = world.tools().find((tool) => tool.name === 'mouse_fix_restore');
const restoreText = await restore.handler({}, {});
assert.match(restoreText, /restored/);
assert.equal(readFileSync(join(host, 'electron-main.cjs'), 'utf8'), FIXTURE_ELECTRON);
assert.equal(readFileSync(join(host, 'mouse-lease.cjs'), 'utf8'), FIXTURE_LEASE);
assert.equal(readFileSync(join(host, 'preload.cjs'), 'utf8'), FIXTURE_PRELOAD);
assert.equal(readFileSync(join(web, 'pet-app.js'), 'utf8'), FIXTURE_PAGE);
assert.equal(readFileSync(join(kit, 'body.js'), 'utf8'), FIXTURE_BODY);

process.chdir(previousCwd);
rmSync(root, { recursive: true, force: true });
console.log('auto-apply tests passed');

