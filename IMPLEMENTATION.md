# 代码详细步骤与思路

作者：funst（QQ 2674459204）  
协议：MIT（宽松开源协议）  
适用：Coopanion 0.2.10 / 0.2.11，Windows  
版本：0.1.8

## 1. 问题链路

未安装补丁时，Coopanion 的桌宠窗口铺满整个工作区，点击穿透时调用：

```js
win.setIgnoreMouseEvents(true, { forward: true });
```

Windows 上 Electron 44.4.4 的 `forward: true` 是全局 `WH_MOUSE_LL` 钩子：

1. 每个物理鼠标事件都在 pet-host 主进程 UI 线程跑一次 `MouseHookProc`；
2. 钩子里对转发窗口做 `GetClientRect` / `ScreenToClient` / `PtInRect`；
3. 再 `PostMessage(WM_MOUSEMOVE)` 给 legacy window；
4. renderer 再分发 `pointermove`。

1000Hz 就是约 1000 次/秒，8000Hz 是 8000 次/秒。窗口铺满工作区，所以鼠标在桌面任何地方移动都命中；隐藏桌宠也不会卸载钩子，只有退出应用或改成 `forward: false` 才会。

## 2. 两阶段修复

### 2.1 0.1.0：关掉全局钩子

改 `cortico-world-desktop-pet` 的宿主文件：

| 文件 | 原代码 | 补丁后 |
|---|---|---|
| `host/electron-main.cjs` | `win.setIgnoreMouseEvents(true, { forward: true });` | `win.setIgnoreMouseEvents(true, { forward: false });` |
| `host/electron-main.cjs` | `const CURSOR_EVERY_MS = 100;` | `const CURSOR_EVERY_MS = 16;` |
| `host/mouse-lease.cjs` | `win.setIgnoreMouseEvents(!hold, { forward: true });` | `win.setIgnoreMouseEvents(!hold, { forward: false });` |

`forward: false` 时 Electron 不调用 `SetForwardMouseMessages`，全局 `WH_MOUSE_LL` 不会安装。桌宠页面仍然每 16ms 收到 `pet:cursor`，用已有的 `elementFromPoint` + `body.hit` + `setInteractive` 决定是否接管鼠标。

这一步解决“桌面整体/桌宠悬停都卡”的问题；实测 8000Hz 下流畅度大幅提升。

### 2.2 0.1.1：拖动时页面/iframe 仍逐事件

拖动时窗口必须变成可交互才能收到 `pointerup`，Windows 仍按 8000Hz 把 `pointermove` 送给页面。原页面处理体每个事件都做：

- `body.pointer('move')` → `postMessage` 进 figure iframe；
- `body.hit` / `overUi`；
- `setInteractive`；
- `followDrag`；
- 诊断对象分配。

8000 次/秒会占满 renderer/iframe 主线程，所以拖动仍卡。

0.1.1 在 `web/pet-app.js` 里保留**原处理体**，只包一层：

```js
// 原处理体改名为一个普通函数
const __mousefixRunPointer = (e) => {
  pointerSeen = true;
  // ...原处理体保持不变...
  followDrag(p);
};

// 新监听器只记最新事件，每帧跑一次
let __mousefixPending = null, __mousefixFrame = 0;
document.addEventListener('pointermove', (e) => {
  __mousefixPending = e;
  if (!__mousefixFrame) __mousefixFrame = requestAnimationFrame(() => {
    __mousefixFrame = 0;
    const ev = __mousefixPending;
    __mousefixPending = null;
    if (ev) __mousefixRunPointer(ev);
  });
});
```

并在 `pointerup` / `pointercancel` / `pointerleave` 里清掉 `__mousefixPending`，避免过期的 move 在离开/松手后把 hover 状态带回来。

效果：8000Hz 时监听器仍然被调用，但只做两次赋值；真正的 DOM/iframe/物理处理降到 60–180 次/秒（跟随刷新率）。

### 2.3 0.1.3：拖动不再消费 pointermove

0.1.1 已把页面处理降到每帧一次，但 8000Hz 拖动仍卡。原因是拖动时窗口是可交互的，Windows 仍把每个物理 move 送进 Chromium；页面虽然只在 rAF 里处理，但事件分发、rAF 调度和 iframe 往返仍可能被 8000Hz 打乱。

0.1.3 改成 **拖动时完全不订阅 move**：

```js
document.addEventListener('pointermove', (e) => {
  if (pressing) return;      // 拖动中不处理 move
  __mousefixPending = e;
  ...
});

host?.onCursor?.((p) => {
  cursor.at = p;
  if (p) {
    body?.pointer('move', { x: p.x, y: p.y, t: performance.now() });
    followDrag(p);
    if (pressing) { setInteractive(true, 'poll'); return; }
  }
  ...
});
```

拖动位置由宿主每 16ms 的 `pet:cursor` 驱动，不再依赖 `pointermove`/rAF；`pointerdown`/`pointerup` 仍用真实事件。这等价于 Ixeris 的“批量/线程化轮询”：输入源仍高频，但消费端固定采样。

同时宿主把光标坐标在窗口外也发给页面（原来窗口外发 `null`），这样拖到屏幕边缘/另一块屏时仍能跟手；非拖动时页面仍会按 hit/UI 判定释放鼠标。

0.1.1 页面升级：0.1.3 会先从 `state.json` 记录的原始备份还原 `pet-app.js`，再重新打 0.1.3 页面补丁；不需要卸载/重装。

### 2.4 0.1.4：让桌宠真的跟得上

0.1.3 把拖动输入改成 16ms 采样后，用户反馈“桌宠跟不上，一顿一顿”。原因不在输入，而在 figure kit 的**拖动缓动**：

```js
pet.dx = lerp(pet.dx, pointer.x, ease(28, dt));
pet.dy = lerp(pet.dy, Math.min(pointer.y, floorY - 245 * S), ease(28, dt));
```

`ease(28, 16ms) ≈ 0.36`：每帧只向光标走 36%，快速拖动时桌宠会落后好几帧，看起来就是“跟不上、一顿一顿”。

0.1.4 做三件事：

1. `body.js` 的拖动缓动从 28/s 改为 **200/s**（60fps 每帧约 96%），既保留一点平滑，又几乎贴住光标；
2. 页面帧循环在 `pressing` 时强制 `full = true`，即使 figure layout 还没报告 `moving`，也按完整帧率跑；
3. 宿主 16ms 光标报告先存最新点，用 `requestAnimationFrame` 每帧执行一次 `body.pointer('move')` / `followDrag`，避免两次 IPC 在一帧内重复、或一帧没有更新。

`body.js` 是新的可选目标；页面/宿主修复不受它影响。升级 0.1.1/0.1.3 时，页面先按备份还原再打 0.1.4 补丁。

### 2.5 0.1.5：目标更新率要跟显示刷新率

0.1.4 把缓动收紧到 200/s 后，用户反馈“连续跟随 + 一顿一顿 + 渲染帧率低 + 125Hz 也卡”。这说明输入不是瓶颈，而是**目标位置更新率**：

- 0.1.3 拖动时只由宿主 16ms 的 `pet:cursor` 驱动，约 **60 次/秒**；
- 显示器如果是 120/165Hz，页面 rAF 跑 120/165，但桌宠目标每 60 次才变一次，渲染 120/165 帧却只有 60 个位置 → 看起来就是一顿一顿；
- 鼠标 125Hz 也卡，因为输入回报率不是限制，60Hz 目标才是。

0.1.5 改成拖动时优先用**真实 `pointermove` 的最新位置**，每帧最多应用一次；16ms 光标报告作为兜底（以及非拖动时的 hover/眼睛跟随）：

```js
document.addEventListener('pointermove', (e) => {
  if (pressing) {
    __mousefixDragPoint = { x: e.clientX, y: e.clientY };
    if (!__mousefixDragFrame) __mousefixDragFrame = requestAnimationFrame(() => {
      ...
      body?.pointer('move', { x: q.x, y: q.y, t: performance.now() });
      followDrag(q);
    });
    return;
  }
  ...
});
```

`pointermove` 仍按 8000Hz 到达，但每次只写一个点；真正的 iframe/物理处理最多每帧一次，目标更新率回到显示刷新率。0.1.4 的 200/s 缓动保留。

0.1.4 页面升级：0.1.5 会先从备份还原 `pet-app.js`，再打 0.1.5 页面；`body.js` 若已 patched 则保持。

### 2.6 0.1.6：2000Hz 以上不再逐事件进页面

0.1.5 实测：**180Hz 屏，125–2000Hz 不卡，2000Hz 以上卡**。这说明目标更新率已经不是问题（0.1.5 已经按帧更新），剩下的是**每个物理 move 仍要进页面一次**：

- 0.1.5 在拖动时仍保留 `pointermove` 监听，即使每帧只处理一个点，2000–8000 次/秒的事件分发/JS 任务仍会挤占渲染；
- 2000Hz 是不卡的边界，正好对应“页面/事件分发还能承受”的上限。

0.1.6 改成：拖动时 `pointermove` **立即 return**，不写点、不调度 rAF；桌宠位置完全由宿主 **5ms（约 200Hz）** 的 `pet:cursor` 驱动，页面再用 rAF 合并到 180Hz 渲染。

```js
document.addEventListener('pointermove', (e) => {
  /* __mousefixCursor180 */
  if (pressing) return;     // 拖动时完全不消费 move
  ...
});

host?.onCursor?.((p) => {
  if (pressing) {
    __mousefixDragPoint = p;
    // rAF 合并到一帧一次
  }
});
```

`CURSOR_EVERY_MS` 从 16 改为 **5**（200Hz），覆盖 180Hz 屏；`pollMs` 默认 5、最小 4。0.1.4 的 `ease(200)` 保留。

Windows 的 `setInterval(5)` 默认会被系统计时器精度钳到约 15.6ms（实测 66 次/秒），所以宿主同时调用 Win32 `timeBeginPeriod(1)`；实测 5ms 定时器变成约 188 次/秒。该调用通过已有的 koffi 加载 `winmm.dll`，失败时静默跳过（非 Windows/无 koffi）。

如果 2000Hz 以上仍然卡，剩下的就是 Chromium/Windows 的原生鼠标消息分发，不是页面 JS；那需要拖动时点击穿透 + 原生/钩子读按键，或原生输入层，不能再靠页面调参。

### 2.7 0.1.7：拖动时点击穿透 + 原生读按键

0.1.6 实测 2000+ 仍卡，说明 Chromium 仍要为每个物理 move 处理一次原生消息，页面再忽略也已经晚了。0.1.7 直接让窗口在拖动时**不接收鼠标**：

1. `preload.cjs` 增加 `dragStart()` 和 `onDragEnd()`；页面在 `pointerdown` 命中身体后调用 `host.dragStart()`。
2. 宿主收到 `pet:dragStart`：
   - 先调用 Win32 `ReleaseCapture()`，释放 Chromium 在 pointerdown 时抓到的原生鼠标捕获；
   - `mouse.ask(false)` + `win.setIgnoreMouseEvents(true, { forward: false })`，窗口立刻点击穿透；
   - 在 5ms 光标定时器里用 `GetAsyncKeyState(VK_LBUTTON)` 读左键，`pet:cursor` 带上 `button`；
   - 左键松开时发 `pet:dragEnd`，`mouse.ask(false)` 保持穿透，等页面下一次 hit 判定再决定是否接管。
3. 页面拖动期间不再调用 `setInteractive(true)`，`pointermove` 直接返回；位置来自 5ms 光标报告，rAF 合并到 180Hz。
4. `pointerleave` 在 `pressing` 时忽略：点击穿透会让页面收到假的 leave，不能让它清掉拖动。

```js
// host, 5 ms cursor tick
const down = mouseFixButtonDown ? mouseFixButtonDown() : false;
at.button = down;
if (!down) {
  mouseFixDragging = false;
  win.webContents.send('pet:dragEnd');
  mouse.ask(false);
}
```

**为什么底层不会误点**：拖动开始时窗口还是可交互的，初始 `mousedown` 已经被桌宠吃掉；之后窗口穿透，下层应用只会收到 `move`/`mouseup`，没有配对的 `mousedown`，所以不会形成一次点击。这是这个方案能成立的关键，也是需要在真实窗口上验证的取舍。

`GetAsyncKeyState` 用已有的 koffi 加载 `user32.dll`；如果读不到（非 Windows/无 koffi），`dragStart` 不做任何事，页面保留 0.1.6 的旧路径。

### 2.8 0.1.8：stop() 自动还原

0.1.8 只改 World 生命周期：

```js
async stop() {
  if (!IN_COOPANION) return;
  const result = restore({ dataDir: this.ctx.dataDir });
  ...
  this.log?.info?.(`鼠标回报率修复：停用，已还原 ...；重启 Coopanion 后完全卸载`);
}
```

- 停用 World 或正常退出时，`stop()` 调 `restore()`，把 5 个文件换回备份的原始字节；
- 已经加载的桌宠宿主不会热卸载，必须重启 Coopanion 才完全回到原版；
- 进程被强杀、或卸载时不调用 `stop()`，仍然要手动 `mouse_fix_restore`；
- 这不改变市场拉黑：仍然改写程序文件、影响所有形象，0.1.8 是 out-of-market mod。

## 3. 代码结构

```
src/
  index.js       WorldDefinition：create()/start()/tools()，配置与工具
  patch.js       文件定位、分类、patch、备份、state、restore
  describe.js    工具自描述（生成 describe.json）
scripts/
  write-describe.mjs
test/
  patch.test.mjs  fake app + 真实 0.2.11 host/page 的 patch/restore
  world.test.mjs
  auto.test.mjs  create() 在 start() 之前自动 patch
describe.json
README.md
IMPLEMENTATION.md
```

### 3.1 `create()` 为什么能赶在桌宠窗口之前

Cortico 的 `WorldAssembly` 构造函数会先对所有 World 调用 `def.create(ctx)`，之后 Core 才按顺序 `start()`。desktop-pet 的窗口是在它的 `start()` 里打开的。因此插件在 `create()` 里 patch 文件，一定早于宿主被 spawn。

```js
create(ctx) {
  const world = new MouseFixWorld(ctx);
  if (ctx.cfg.enabled && ctx.cfg.autoApply && IN_COOPANION) {
    world.initial = apply({ dataDir: ctx.dataDir, pollMs: ctx.cfg.pollMs });
  }
  return world;
}
```

### 3.2 文件定位

`locateAppRoot()` 依次尝试：

1. Core 的 `process.cwd()`（Coopanion 启动 Core 时就是 `resources/app`）；
2. `CORTICO_APP_ROOT`（预留给开发/测试）；
3. 可执行文件旁的 `resources/app`；
4. macOS 的 `../Resources/app`。

只接受 `package.json` 里 `name === "coopanion"` 且存在 `node_modules/cortico-world-desktop-pet/host/electron-main.cjs` 的目录。

### 3.3 patch 安全

- 每个 host 目标必须匹配**恰好一次**；0 次或多次都拒绝。
- 页面块是**可选**的；页面改版时只跳过页面，host 修复仍生效，状态标 `skipped`。
- patch 前把原文件按 `sha256` 内容寻址备份到 `<data>/mouse-polling-fix/backups/<hash>/<file>`。
- `state.json` 记录 original/patched 哈希、备份路径、app/host 版本、pollMs、错误。
- 写入用临时文件 + `rename`；失败回退直接写。
- `mouse_fix_restore` 只在当前文件哈希等于我们记录的 patched 哈希时才还原；app 更新或手工改过会拒绝。

### 3.4 三个工具

| 工具 | 作用 |
|---|---|
| `mouse_fix_status` | 只读：版本、三文件状态、备份、上次错误 |
| `mouse_fix_apply` | 重新 patch（可在 Coopanion 更新后手动触发） |
| `mouse_fix_restore` | 按备份精确还原 |

## 4. 激活：必须重启两次

这是插件的关键使用约束：

1. **安装扩展后重启 Coopanion**  
   扩展包需要重新加载；不重启，World 不会出现在已加载列表里。
2. **在 Worlds 里启用「鼠标回报率修复」**  
   启用会写 `worlds.mouse-polling-fix.enabled = true`。
3. **再重启一次 Coopanion**  
   只有下一次启动，`create()` 才会在桌宠宿主启动前运行并写入补丁。

> 只做第 1 步或只做第 2 步都不会生效。  
> 如果安装的是新版本（0.1.1/0.1.2/0.1.3/0.1.4/0.1.5/0.1.6/0.1.7），第一次重启加载新代码，第二次重启应用新补丁。

验证：让 Coo 调 `mouse_fix_status`，三行都应该是 `patched`。

## 5. 更新与还原

### Coopanion 更新

`resources/app` 被更新器替换后，补丁丢失。下次启动时，World 仍启用，`create()` 看到新的原始文件，重新备份并 patch，然后桌宠宿主才启动。若新版本代码行变了，`mouse_fix_status` 报 `unsupported`，文件保持不动，等插件更新。

### 插件更新

npm 版本更新 → Coopanion 扩展页提示 → 重启加载新代码 → 下次启动重新 patch。0.1.2 只改元数据；0.1.3–0.1.7 改拖动采样、缓动、目标更新率与点击穿透，升级时会从备份重打页面，不需要卸载。

### 还原

`mouse_fix_restore` → 重启 Coopanion。或先还原再卸载扩展；直接删扩展不会自动还原文件。

## 6. 为什么是 World 而不是 core 修改

- Cortico World 是外部 IO 的隔离边界；这个插件只做“安装/更新时修补桌宠宿主”，不参与 AI 事件流。
- 它不修改 Coopanion 主进程、Core、记忆或其它扩展；只改 desktop-pet 包里的三行 host + 一个页面包装。
- 通过 npm 安装/更新，扩展市场能显示版本与更新；这满足“算插件、可更新”。
- 因为改的是已安装文件，所以标 `experimental`/`apps`，README 明确风险；它不是官方扩展。

## 7. 验证

```bash
node test/patch.test.mjs    # fake app + 真实 0.2.11 文件 patch/restore
node test/world.test.mjs    # World/describe 形状
node test/auto.test.mjs     # Coopanion 环境 + create() 自动 patch
```

真实 0.2.11 的 `electron-main.cjs`、`mouse-lease.cjs`、`pet-app.js` 均完成 patched → restored 字节级校验；patch 后的 `pet-app.js` 通过 `node --input-type=module --check`。

## 8. 已知取舍

- 仅 Windows。
- 关闭 `forward` 后，桌宠在空白桌面不再逐事件追踪鼠标；眼睛/身体跟踪在鼠标进入桌宠后恢复。
- 进入桌宠第一帧（≤16ms）点击可能穿透。
- 会修改已安装文件；Program Files 下可能无写权限；更新/杀毒可能注意到。
- 8000Hz 下如果还有卡顿，下一步是缩小透明窗口/改原生 raw input，或升级 Electron；0.1.7 已让拖动时窗口点击穿透，并用原生 `GetAsyncKeyState` 读左键，2000+ 的 move 不再进入 Chromium 页面。

## 9. 作者与协议

- 作者：funst
- QQ：2674459204
- License：MIT
- 仓库/问题：npm 包页 `cortico-world-mouse-polling-fix`
