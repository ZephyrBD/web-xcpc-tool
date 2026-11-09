# 登录审批 + 启动体验修复 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 登录时段外队伍码登录走管理员审批（同意当次有效），并修复启动日志/管理员密码/气球空 contestId 三处启动体验问题。

**Architecture:** 服务端新增 `LoginRequestStore`（`data/login-requests.json`，JsonStore 模式）；verify 流程在 outside-window 且队伍码正确时创建 pending 请求，队伍侧等待页轮询 + SSE 通知管理端，管理端在改名后的「认证管理」页审批。管理员密码首次随机生成、明文存 settings.json、每次启动打印。

**Tech Stack:** Bun + Hono（server）、Vue 3 + Element Plus（admin）、bun:test。

**Spec:** `docs/superpowers/specs/2026-11-09-login-approval-and-startup-dx-design.md`

## Global Constraints
- 无数据库：一切持久化走 `data/` 下 JSON（JsonStore），`apps/server/src/store/store.ts` 的 `JsonStore<T>` 复用
- DOMjudge baseUrl 只来自配置；`DjClient` 已剥尾斜杠（client.ts:147），不得破坏
- 面向队伍的 HTML 页全部内联（无外部资源），沿用 `teamPages.ts` 的 `page()` 与 PALETTE
- GPL-2.0 头不需要（仅 Gradle 文件要求）；中文文案面向队伍/管理员
- server 测试 `cd apps/server && bun test`（当前 285 全绿），admin `cd apps/admin && bun test`（104 全绿）；typecheck：server `bunx tsc --noEmit`、admin `bunx vue-tsc --noEmit`
- 不重启 8080 上运行中的服务（由用户决定何时重启）

## Review Focus
1. 时段开着时提交队伍码绝不产生审批请求（行为完全不变）——测试：Task 1
2. 审批同意后 claim 必须消费请求（第二次 claim 失败），重启后请求状态保留——测试：Task 1
3. 队伍码错误在时段外仍报「队伍码不正确」而非等待页——测试：Task 1
4. 管理员改密码后明文字段与哈希同步更新——测试：Task 3
5. contestId 为空时零轮询、零报错，仅启动提示一次——测试：Task 4

---

### Task 1: LoginRequestStore + verify 审批流（server）

**Files:**
- Create: `apps/server/src/auth/loginRequests.ts`
- Create: `apps/server/src/auth/loginRequests.test.ts`
- Modify: `apps/server/src/domjudge/verify.ts`（verifyTeamCode 增加 requestStore 依赖与 waiting 结果分支）
- Modify: `apps/server/src/server.ts:98-126`（/dj/verify 接线）+ 新路由
- Modify: `apps/server/src/pages/teamPages.ts`（新增等待页）
- Test: `apps/server/src/server.test.ts`（追加审批流用例）

**Interfaces:**
- Produces: `LoginRequestStore`（构造 `new LoginRequestStore(path: string)`，方法 `create(req: {icpcId, teamCode, teamName, ip}) => LoginRequest`、`get(id) => LoginRequest | null`、`listPending() => LoginRequest[]`、`listAll() => LoginRequest[]`、`decide(id, "approved" | "rejected") => LoginRequest | null`、`consume(id) => LoginRequest | null`（仅 approved 可消费，消费后状态 `claimed`）
- Produces: `type LoginRequest = { id: string; icpcId: string; teamCode: string; teamName: string; ip: string | null; requestedAt: string; status: "pending" | "approved" | "rejected" | "claimed"; decidedAt: string | null }`
- Produces: 路由 `GET /dj/verify/wait?req=<id>`（HTML 等待页，内联 JS 每 5s fetch status）、`GET /dj/verify/status?req=<id>`（JSON `{status}`）、`GET /dj/verify/claim?req=<id>&next=…`（approved 时签 token、Set-Cookie、302 next，并 consume；否则 403 HTML）
- Consumes: `teamStore.findByTeamCode`、`signTeamToken(cfg.jwt.secret, cfg.jwt.ttlSeconds, icpcId)`（verify.ts 现有用法）

- [ ] **Step 1: 写 loginRequests.test.ts**：create 生成 uuid 与 pending 状态；decide 仅 pending 可改为 approved/rejected；consume 仅 approved 成功且置 claimed（二次 consume 返回 null）；重启保留（同 path 重建 store 读取状态）
- [ ] **Step 2: 运行确认失败**：`bun test src/auth/loginRequests.test.ts` → FAIL
- [ ] **Step 3: 实现 LoginRequestStore**（JsonStore<LoginRequest[]>，uuid 用 `crypto.randomUUID()`）
- [ ] **Step 4: 测试通过后接 verify 流**：`/dj/verify` 中 `outside-window` 时先 `findByTeamCode(code)`——命中则 `create`（同队已有 pending 则复用原请求）并返回等待页；未命中仍 `verifyMissPage()`。等待页 JS：轮询 status，`approved` → `location.href="claim"`；`rejected` → 显示「管理员拒绝了本次登录，可重新提交」并给返回表单链接。`claim`：status=approved → 签 token、写登录历史（复用 server.ts:114 现有 append）、Set-Cookie 同 server.ts:123、consume、302
- [ ] **Step 5: server.test.ts 追加用例**：时段外+正确码 → 等待页含请求 id；管理端 decide approved 后 claim → 302 且带 Set-Cookie；二次 claim → 403；时段外+错误码 → 403 队伍码不正确；时段内正常登录 → 不产生请求（`listAll()` 为空）
- [ ] **Step 6: `bun test` 全绿 + `bunx tsc --noEmit`，commit `feat(server): team-code login approval flow`**

### Task 2: 管理端审批 API + SSE（server）

**Files:**
- Modify: `apps/server/src/server.ts`（admin 路由区，login-history 附近）
- Test: `apps/server/src/server.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `LoginRequestStore`；`SseBus.publish(channel, event, data)`（bus.ts:6）
- Produces: `GET /admin/api/login-requests`（`{pending: LoginRequest[], recent: LoginRequest[]}`，recent=非 pending 按 requestedAt 倒序取 50）、`POST /admin/api/login-requests/:id/decision` body `{decision: "approved" | "rejected"}`（返回更新后的 LoginRequest，404 未知 id）；新请求创建时 `publish("admin", "login-request", LoginRequest)`（队伍侧等待页被 approve 后由 status 轮询发现，无需 SSE）

- [ ] **Step 1: server.test.ts 写失败用例**：createApp deps 传入 LoginRequestStore（新增 `deps.loginRequests`，类型 `LoginRequestStore | undefined`，未传时 createApp 内部以 dataDir 路径自建，同 loginHistory 模式）；未认证 401；认证后 GET 两个列表；POST decision 改状态；SSE 收到 login-request 事件
- [ ] **Step 2: 运行确认失败**
- [ ] **Step 3: 实现路由与 deps**（`createApp` 签名的 deps 类型加 `loginRequests?: LoginRequestStore`）
- [ ] **Step 4: 测试全绿 + tsc，commit `feat(server): admin login-request review api`**

### Task 3: 管理员密码生成/打印 + 启动横幅 + 气球空 contestId（server）

**Files:**
- Modify: `apps/server/src/config.ts`（schema `admin.password: z.string().optional()`；新增 `ensureAdminPassword(cfg, configPath): Config`——passwordHash 为空时生成 16 位可读随机密码（去掉易混淆 0O1lI 的字母表），bcrypt `hashSync(pw, 10)` 存哈希、明文存 `admin.password`，写回 settings.json；passwordHash 已存在但 `admin.password` 缺失则保持登录可用、日志提示重设）
- Modify: `apps/server/src/index.ts`（调用 ensureAdminPassword；重写启动横幅：`Web XCPC Tool <version>(<hash>)` + 服务地址/管理台地址/管理用户名与密码/DOMjudge 上游/气球赛题 ID，未配置 contestId 时打「气球联动未启用：未配置赛题 ID」）
- Modify: `apps/server/src/balloon/service.ts:100`（`start()` 中 contestId 为空直接不 schedule，置 running=false）
- Modify: `apps/server/src/admin/settings.ts:94-104`（patch.admin.password 同时更新 passwordHash 与明文 password）
- Test: `apps/server/src/config.test.ts`、`apps/server/src/admin/settings.test.ts`、`apps/server/src/balloon/service.test.ts`

**Interfaces:**
- Produces: `ensureAdminPassword(cfg: Config, configPath: string): Config`（幂等：已有哈希+明文时原样返回）
- Consumes: `getVersionInfo()`（version.ts，横幅显示版本与 hash）

- [ ] **Step 1: 失败测试**：config——空哈希首次调用生成哈希+明文并写盘；二次调用幂等不换密码；settings——PUT admin.password 后 passwordHash 与 password 都更新且能登录；balloon——contestId 空 start() 不轮询（计时器不建立）
- [ ] **Step 2: 确认失败 → 实现 → 全绿**
- [ ] **Step 3: index.ts 横幅**（纯 console.log 输出，无测试要求；去掉 `cuitxcpctool` 字样）
- [ ] **Step 4: `bun test` 全绿 + tsc，commit `feat(server): admin password bootstrap, startup banner, balloon guard`**

### Task 4: 认证管理页（admin 前端）

**Files:**
- Rename: `apps/admin/src/pages/TeamCodesPage.vue` → `apps/admin/src/pages/AuthPage.vue`
- Rename test 同步；Modify: `apps/admin/src/router/index.ts:15`（path `/auth`，name `auth`，title「认证管理」）、侧边导航组件（grep `team-codes` 找到 nav 项）、`HelpPage.vue:48` 与 `ApiListPage.vue:20` 文案（入口描述改为「认证管理页」）
- Create: `apps/admin/src/pages/LoginRequestsCard.vue`（审批卡片，AuthPage 引入）
- Test: `apps/admin/src/pages/AuthPage.test.ts`、`LoginRequestsCard.test.ts`

**Interfaces:**
- Consumes: Task 2 API（`/admin/api/login-requests`、POST decision）、现有 `apiFetch`/`getToken` 工具、Element Plus `el-table`/`el-button`/`ElMessageBox.confirm`（照 JobsPage ack 的写法）
- Produces: AuthPage = 原 TeamCodesPage 内容 + 新「登录审批」卡片：pending 表格（队伍名/队伍码/申请时间/IP/同意|拒绝按钮），操作后刷新并 ElMessage 成功提示；recent 折叠展示（状态 tag：已同意/已拒绝/已使用）
- 后端 API 路径 `/admin/api/team-codes*` 保持不变（仅前端页面改名，避免破坏接口兼容）

- [ ] **Step 1: 失败测试**：AuthPage 渲染含「登录审批」与原队伍码功能；LoginRequestsCard 挂载调 GET 渲染 pending 行；点同意调 POST decision 且成功后刷新列表
- [ ] **Step 2: 确认失败 → 实现（rename 用 git mv，路由/导航/文案同步）→ 测试全绿**
- [ ] **Step 3: `bunx vue-tsc --noEmit` + `bun run build`，commit `feat(admin): auth management page with login approval`**

### Task 5: 全链路验证 + 文档

**Files:**
- Modify: `README.md`（功能列表加「登录时段外队伍码审批登录」一句）、`apps/admin/src/pages/HelpPage.vue` 审批流程说明
- Test: 冒烟（手动）

- [ ] **Step 1: 两套测试 + 双 typecheck + admin build 全绿**
- [ ] **Step 2: 手动冒烟**（不重启 8080 现服务；用临时端口 `PORT=18080 bun run src/index.ts` 起实例）：设置一个已过去的登录时段 → 浏览器输队伍码 → 等待页出现；管理台认证管理看到请求 → 同意 → 等待页自动跳转进 DOMjudge；重启临时实例验证请求状态保留、启动横幅打印密码。冒烟后清理临时实例与临时 data 目录
- [ ] **Step 3: commit `docs: login approval flow documentation`**
