# 比赛设置合并 + 气球迷你重构 + 日志系统 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 合并「比赛设置」板块并让设置实时生效、气球改为直接读 DOMjudge balloons API、新增清空已拉取数据（含比赛 ID 解锁）、实现统一彩色日志（单文件 latest）。

**Architecture:** 配置从启动快照改为运行时可变引用（`ConfigStore` 持有当前 Config，PUT 保存后原子替换并热重载下游服务）；气球服务只调 `getBalloons`，状态以 `done` 为准；新增 `logger.ts` 统一输出（控制台 ANSI、文件无色、密码脱敏）；新增 `POST /admin/api/data/purge`。

**Tech Stack:** Bun + Hono（server）、Vue 3 + Element Plus（admin）、bun:test。

**Spec:** `docs/superpowers/specs/2026-11-09-login-approval-and-startup-dx-design.md` + 本轮对话裁定（见 Global Constraints）

## Global Constraints
- **比赛 ID 锁定**：`balloon.contestId` 非空后网页不可改，服务端拒绝变更（403）；唯一解锁路径是「清空数据」（置空）。
- **清空数据范围**：队伍列表、队伍账号密码、队伍码、登录历史、审批记录、打印任务+留档源码+PDF、气球任务、**比赛 ID 置空**；保留 settings.json 其余配置与 secret.key。
- **清空后**：等比空重设比赛 ID，保存即自动开始气球轮询。
- **滚动数据源**：气球任务完全来自 `GET /api/v4/contests/{id}/balloons`，**禁止**再拉 judgements/judgement-types/submissions 合成。
- **日志**：格式 `{dd} {hh:mm:ss} {name:>9} [{X}] {msg}`；控制台 ANSI 16 色（时间戳灰 90、标签按级别 36/33/31/1;91/90），名字与消息不上色，每段以 `\x1b[0m` 收尾；非 TTY 或 `NO_COLOR` 去色；Windows 零依赖开 VT。
- **日志文件**：单个 `data/logs/latest.log`，启动截断，任何 ANSI 都不写入，密码段写成 `********`。
- 无数据库；不重启 8080 上的服务；GPL 头无需；中文文案。

## Review Focus
1. 比赛 ID 锁定必须服务端强制（绕过前端 PUT 直接改也必须 403）——测试 Task 2
2. 清空后 `contestId` 为空时气球不轮询；重新设置后自动起轮询——测试 Task 3
3. 气球 `done:true` 由 DOMjudge 主导，本地 ack 不再乐观置 delivered——测试 Task 4
4. 日志文件绝不含 ANSI 与密码明文——测试 Task 5
5. 设置实时生效：改登录时段后不重启即按新时段判定——测试 Task 1

---

### Task 1: 配置运行时可变（ConfigStore）+ 设置热生效

**Files:**
- Create: `apps/server/src/store/configStore.ts`、`apps/server/src/store/configStore.test.ts`
- Modify: `apps/server/src/server.ts`（createApp 签名接受 `ConfigStore`，全部 `cfg.` 读取改 `configStore.current`）、`apps/server/src/admin/settings.ts`、`apps/server/src/index.ts`
- Test: `apps/server/src/server.test.ts`、`apps/server/src/admin/settings.test.ts`

**Interfaces:**
- Produces: `class ConfigStore { constructor(initial: Config); get current(): Config; replace(next: Config): void; onChange(cb: (next: Config) => void): () => void }`
- Consumes: 既有 `Config` 类型、`applySettingsPatch`
- 注意：为兼容既有调用与测试，`createApp` 同时接受旧的 `Config` 字面量与 `ConfigStore`

- [ ] **Step 1: 写失败测试**（configStore.test.ts）：`current` 返回初始值；`replace` 后 `current` 变更；`onChange` 回调收到新值；取消订阅后不再回调
- [ ] **Step 2: 运行确认失败** → **Step 3: 实现 ConfigStore** → **Step 4: 通过**
- [ ] **Step 5: 写失败测试**（server.test.ts）：PUT `/admin/api/settings` 修改 `teamLogin.end` 为过去时间后，**同一实例**再次 `GET /dj/verify?code=<有效码>` 返回等待页（说明时段实时生效）
- [ ] **Step 6: 实现**——`createApp` 内部统一经 `configStore.current` 读取；PUT 成功后 `configStore.replace(updated)`；`index.ts` 构造 `ConfigStore` 并传
- [ ] **Step 7: 全绿 + tsc，commit `feat(server): runtime config store with hot reload`**

### Task 2: 比赛 ID 锁定（服务端强制）

**Files:**
- Modify: `apps/server/src/admin/settings.ts`（`settingsPatchSchema` 之外新增校验函数）、`apps/server/src/server.ts`（PUT 路由，403 返回 `contestId locked`）
- Test: `apps/server/src/admin/settings.test.ts`、`apps/server/src/server.test.ts`

**Interfaces:**
- Produces: `assertContestIdMutable(current: Config, patch: SettingsPatch): { ok: true } | { ok: false; reason: "locked" }`——当前 `contestId` 非空且 patch 提供了不同的非空值 → locked；patch 为空串（清空流程）允许
- 清空数据走 Task 3 的专用端点，不经过 settings PUT

- [ ] **Step 1: 失败测试**：contestId 为空时可设；已设时改同值允许、改不同值 403、传空串通过校验（供清空流程）
- [ ] **Step 2: 确认失败 → 实现 → 全绿**
- [ ] **Step 3: commit `feat(server): lock contest id after first set`**

### Task 3: 清空已拉取数据端点

**Files:**
- Create: `apps/server/src/admin/purge.ts`、`apps/server/src/admin/purge.test.ts`
- Modify: `apps/server/src/server.ts`（`POST /admin/api/data/purge`）、`apps/server/src/index.ts`（清空后重启气球轮询）
- Test: `apps/server/src/admin/purge.test.ts`、`apps/server/src/server.test.ts`

**Interfaces:**
- Produces: `purgePulledData(deps: { dataDir: string; stores: JsonStore<unknown>[]; contestIdReset: () => void }): PurgeReport`，`PurgeReport = { teams: number; passwords: number; printTasks: number; balloonTasks: number; loginHistory: number; loginRequests: number; filesRemoved: number }`
- 删除目录：`<dataDir>/printed`、`<dataDir>/pdf`
- 重置：各 store 写回空数组；`settings.json` 的 `balloon.contestId` 置空（保留其它配置与 secret.key）
- 端点返回 `PurgeReport`，鉴权由 `/admin/api/*` 中间件承担

- [ ] **Step 1: 失败测试**：预置各 store 数据 + 两个目录 → purge 后全部为空、目录不存在、`settings.json` 中 contestId 为空且 domjudge 段未变、`secret.key` 仍在
- [ ] **Step 2: 确认失败 → 实现 → 全绿**
- [ ] **Step 3: route 测试**：未认证 401；认证后 200 且返回计数字段
- [ ] **Step 4: `index.ts` 接线**：purge 完成后 `balloonService.stop()`（contestId 已空）
- [ ] **Step 5: commit `feat(server): purge pulled data endpoint`**

### Task 4: 气球直接读 balloons API

**Files:**
- Modify: `apps/server/src/balloon/service.ts`（重写 `pollOnce`）、`apps/server/src/balloon/service.test.ts`
- Modify: `apps/server/src/domjudge/client.ts`（若需补 `DjBalloon` 字段）
- Modify: `apps/server/src/server.ts`（任务列表字段如有变化）

**Interfaces:**
- `BalloonTask` 改为 `{ id: string; contestId: string; problemLabel: string; teamName: string; location: string | null; status: "pending" | "delivered"; createdAt: string; balloonId: string | null }` 保持字段名不变（`id` 现在等于 `balloonid`），避免破坏前端
- `pollOnce` 只调 `client.getBalloons(contestId)` + 本地队伍表
- `done: true` → delivered；`done: false` → pending（**DOMjudge 权威**）
- `ack()` 只 POST done，随后由下一轮轮询反映真实状态

- [ ] **Step 1: 失败测试**：两个气球（一个 done:true 一个 false）→ 生成 2 个任务、状态正确；第二轮 done 翻转为 true → 本地变 delivered；不再调用 getJudgings/getSubmissions（用 mock 断言调用次数为 0）
- [ ] **Step 2: 确认失败 → 实现 → 全绿（旧 judge 合成相关测试删除或改写）**
- [ ] **Step 3: 空列表提示**：连续 3 轮 balloons 为空且 contestId 非空 → 日志 WARNING「气球列表为空：DOMjudge 可能未启用气球功能」
- [ ] **Step 4: commit `refactor(balloon): read tasks from domjudge balloons api`**

### Task 5: 日志系统

**Files:**
- Create: `apps/server/src/log/logger.ts`、`apps/server/src/log/logger.test.ts`
- Modify: `apps/server/src/index.ts`（初始化 logger、启动横幅改用 logger）、各模块 `console.*` 替换（grep `console.` 于 `apps/server/src`）
- Test: `apps/server/src/log/logger.test.ts`

**Interfaces:**
- Produces: `createLogger(opts: { filePath?: string; color?: boolean; stream?: NodeJS.WriteStream }): { debug/info/warn/error/critical(name: string, msg: string, ...args: unknown[]): void }`；`initLogger({ logFilePath, console: boolean }): void` + 模块级 `log.<level>(name, msg)`
- 格式：`${dd} ${HH}:${mm}:${ss} ${name.padStart(9)} [${tag}] ${msg}`；多行续行按前缀可见宽度缩进
- 脱敏：`logger.redact?` 或 `initLogger({ secrets: string[] })`——启动时登记明文密码，输出前替换为 `********`（仅文件；控制台保留明文）
- VT 开启：`process.platform === "win32"` 时用 Bun 的 ANSI 支持（Bun 在 Windows 默认已启用 VT，验证后若不需要额外处理则跳过）+ 非 TTY / `NO_COLOR` / `FORCE_COLOR=0` 去色

- [ ] **Step 1: 失败测试**：格式化输出匹配正则 `^\d{2} \d{2}:\d{2}:\d{2} +\w+ \[\w\] .+$`；名字右对齐宽度 9；`color:false` 时无 `\x1b`；文件输出无 ANSI；登记的 secret 在文件中被 `********` 替换、控制台保留
- [ ] **Step 2: 确认失败 → 实现 → 全绿**
- [ ] **Step 3: 启动横幅改为 logger**（`[I]` 级，含管理端地址与 admin/密码，密码仅控制台）
- [ ] **Step 4: 替换各模块 console 调用**，文件按天截断（启动时 `writeFileSync(path, "")`）
- [ ] **Step 5: commit `feat(server): structured terminal and file logger`**

### Task 6: 前端——比赛设置卡片 + 清空数据

**Files:**
- Modify: `apps/admin/src/pages/SettingsPage.vue`（合并卡片、锁定只读、清空按钮）、`apps/admin/src/pages/TeamsPage.vue`（删比赛 ID 输入框）
- Modify: `apps/admin/src/pages/HelpPage.vue`、`ApiListPage.vue` 文案
- Test: `SettingsPage.test.ts`、`TeamsPage.test.ts`

- [ ] **Step 1: 失败测试**：比赛 ID 有值时输入框 readonly 且显示锁定提示；无值时可用；点「清空数据」需输入「清空」确认后调 purge API；TeamsPage 不再渲染 contest 输入框
- [ ] **Step 2: 确认失败 → 实现 → `bun test` + `vue-tsc` + `build`**
- [ ] **Step 3: 去掉「重启后生效」提示**（仅端口/JWT 例外说明保留）
- [ ] **Step 4: commit `feat(admin): contest settings card and data purge`**

### Task 7: 冒烟 + 文档

- [ ] **Step 1: 全量测试**（server/admin）+ typecheck + build
- [ ] **Step 2: 临时端口冒烟**：清空 → 设比赛 ID → 气球自动开始 → 改登录时段实时生效 → 日志文件无密码无 ANSI
- [ ] **Step 3: 更新 README / deploy.md / HelpPage**
- [ ] **Step 4: commit `docs: contest settings and balloon api notes`**
