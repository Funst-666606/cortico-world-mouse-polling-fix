/**
 * A Cortico World that makes Coopanion's desktop pet usable with a high-polling-rate mouse.
 *
 * The pet host is a separate Electron process. On Windows, Electron 44.4.4 implements
 * `setIgnoreMouseEvents(true, { forward: true })` with a global WH_MOUSE_LL hook: every
 * physical mouse move costs a hook callback, a few user32 calls and a PostMessage, and the
 * pet page handles another pointermove. Above roughly 500 Hz the queue no longer drains and
 * the whole desktop feels laggy.
 *
 * This World does not receive or forward mouse events itself. It patches the installed
 * desktop-pet host (with backups and a restore path) so it calls `{ forward: false }` and
 * polls the cursor every 5 ms; the page already knows how to use `pet:cursor`. The global
 * hook is then never installed. It is a mod, not an input World: see README for the tradeoff.
 */
import { DESCRIBE } from './describe.js';
import {
  DEFAULT_POLL_MS,
  apply,
  inspect,
  locateAppRoot,
  normalisePollMs,
  restore,
} from './patch.js';

const ID = 'mouse-polling-fix';

/** Set by Coopanion's main process for its Core child; absent in tests, dry-mount and a plain Cortico. */
const IN_COOPANION = !!process.env.COOPANION_VERSION && process.env.CORTICO_SUPERVISED === '1';

/** Whether the optional page wrapper was left alone because the page block did not match. */
const pageSkipped = (result) => Array.isArray(result?.files)
  && result.files.some((file) => file.name === 'pet-app.js' && file.state === 'skipped');

/** @typedef {{ enabled: boolean, pollMs: number, autoApply: boolean }} MouseFixConfig */

class MouseFixWorld {
  constructor(ctx) {
    this.id = ID;
    this.ctx = ctx;
    this.log = null;
    /** Last inspect/apply result, for the tool receipts and logs. */
    this.last = null;
    /** The patch result from construction, before a logger exists. */
    this.initial = null;
  }

  envPromptVars() {
    return null;
  }

  tools() {
    const handlers = {
      mouse_fix_status: () => this.status(),
      mouse_fix_apply: (args) => this.applyNow(args),
      mouse_fix_restore: () => this.restoreNow(),
    };
    return DESCRIBE.tools.map((tool) => {
      const { summary, ...schema } = tool;
      return { ...schema, handler: handlers[tool.name] };
    });
  }

  async start(host) {
    this.log = host.log;
    if (!this.ctx.cfg.enabled) return;
    if (!this.ctx.cfg.autoApply) {
      this.log.info('鼠标回报率修复：autoApply 已关闭，等工具或手动触发');
      return;
    }
    // create() already patched before the pet host started. This is a verification pass and a
    // second chance when the World was enabled at runtime; it never rewrites a patched file.
    const result = apply({ dataDir: this.ctx.dataDir, pollMs: this.ctx.cfg.pollMs });
    this.last = result;
    if (!result.ok) {
      this.log.warn(`鼠标回报率修复：补丁未完成：${result.error ?? 'unknown error'}`);
    } else if (result.changed) {
      this.log.info('鼠标回报率修复：补丁已写入；如果桌宠窗口已经在运行，重启 Coopanion 后生效');
    } else {
      this.log.info(`鼠标回报率修复：已生效（${result.appVersion ?? '?'} / poll ${result.pollMs} ms）`);
    }
    if (pageSkipped(result)) {
      this.log.warn('鼠标回报率修复：pet-app.js 的 pointermove 合并未应用（页面代码不匹配），拖动仍可能在高回报率下卡；请更新扩展');
    }
  }

  async stop() {}

  status() {
    if (!IN_COOPANION) return 'Mouse Polling Fix: not running inside Coopanion; nothing was patched.';
    const result = inspect({ dataDir: this.ctx.dataDir, pollMs: this.ctx.cfg.pollMs });
    this.last = result;
    if (!result.ok) return `Mouse Polling Fix: cannot inspect the Coopanion install: ${result.error}`;
    const lines = [
      `Mouse Polling Fix: ${result.patched ? 'patched' : result.supported ? 'not patched' : 'unsupported host files'}`,
      `Coopanion ${result.appVersion ?? '?'} / desktop-pet host ${result.hostVersion ?? '?'}`,
      `app: ${result.appRoot}`,
      `cursor poll: ${result.pollMs} ms; state: ${result.statePath}`,
      ...result.files.map((file) => `- ${file.name}: ${file.state}${file.backupExists ? ' (backup ok)' : ' (no backup)'}`),
    ];
    if (result.error) lines.push(`last error: ${result.error}`);
    if (result.patched) lines.push('If the pet window was already running when the patch was written, restart Coopanion.');
    return lines.join('\n');
  }

  applyNow(args = {}) {
    if (!IN_COOPANION) return 'Mouse Polling Fix: not running inside Coopanion; nothing changed.';
    const pollMs = normalisePollMs(args.poll_ms ?? this.ctx.cfg.pollMs);
    const result = apply({ dataDir: this.ctx.dataDir, pollMs });
    this.last = result;
    if (!result.ok) {
      return `Mouse Polling Fix: patch failed${result.error ? `: ${result.error}` : ''}. See mouse_fix_status.`;
    }
    if (pollMs !== this.ctx.cfg.pollMs) {
      try {
        this.ctx.persist({ pollMs });
      } catch { /* the patch is in effect; the next start keeps the old interval */ }
    }
    const lines = [
      result.changed ? 'Mouse Polling Fix: patch written.' : 'Mouse Polling Fix: already patched, nothing changed.',
      `Coopanion ${result.appVersion ?? '?'} / host ${result.hostVersion ?? '?'}; cursor poll ${result.pollMs} ms.`,
      'Restart Coopanion if the pet window is already running.',
    ];
    if (pageSkipped(result)) lines.push('pet-app.js pointermove coalescing was skipped (page block does not match); dragging may still stutter at very high polling rates. Update the extension.');
    if (result.error) lines.push(`note: ${result.error}`);
    return lines.join('\n');
  }

  restoreNow() {
    if (!IN_COOPANION) return 'Mouse Polling Fix: not running inside Coopanion; nothing changed.';
    const result = restore({ dataDir: this.ctx.dataDir });
    this.last = result;
    if (!result.ok) {
      return `Mouse Polling Fix: restore incomplete${result.error ? `: ${result.error}` : ''}.`;
    }
    return `Mouse Polling Fix: restored ${result.restored.length ? result.restored.join(', ') : 'nothing (already original)'}. Restart Coopanion.`;
  }
}

/** @type {import('cortico/world.ts').WorldDefinition<MouseFixConfig>} */
const definition = {
  id: ID,
  label: 'Mouse Polling Fix',
  defaults: () => ({ enabled: false, pollMs: DEFAULT_POLL_MS, autoApply: true }),
  describe: DESCRIBE,
  preflight() {
    // `check:extension` and dry mounts run outside Coopanion; they must not fail because the
    // app directory is absent. Only a real enable inside Coopanion is checked.
    if (!IN_COOPANION) return;
    if (process.platform !== 'win32') throw new Error('Mouse Polling Fix is Windows only.');
    const found = locateAppRoot();
    if (found.error) throw new Error(found.error);
  },
  create(ctx) {
    const world = new MouseFixWorld(ctx);
    // create() runs for every World before any World starts, so this is still before the
    // desktop-pet host is spawned. Doing it in start() would be too late on a normal launch.
    if (ctx.cfg.enabled && ctx.cfg.autoApply && IN_COOPANION) {
      world.initial = apply({ dataDir: ctx.dataDir, pollMs: ctx.cfg.pollMs });
    }
    return world;
  },
};

export default definition;
