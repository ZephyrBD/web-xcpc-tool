# Plan 3: 管理端前端重写 + 加固与部署 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用 Vue 3 + Vite + Element Plus 重写管理端（按 DESIGN-md.md 的 playful 五色设计标准），补上管理端 API 鉴权，加固静态托管，移除 xcpcio，落地部署脚本与 CI。

**Architecture:** `apps/admin` 构建产物输出到 `apps/server/static`（由 Plan 1 的静态托管逻辑服务，本次加固）；服务器端新增管理员登录（JWT session）+ `/admin/api/*` 鉴权中间件；前端五个页面（登录、总览、认证任务、打印/气球任务、队伍）共享一套 design tokens 与布局壳。

**Tech Stack:** Vue 3 + TS + Vite + Element Plus（CSS 变量主题定制）+ Pinia + Vue Router；后端复用 Plan 1/2 全部接口；CI 用 GitHub Actions。

**Spec:** `docs/superpowers/specs/2026-11-07-ts-bun-rewrite-design.md` + 设计标准 `docs/superpowers/specs/DESIGN-md.md`（Figma Playful Color，本计划的视觉权威）

**Design standard summary（视觉约束，全局生效）：**
- 色板：`--brand-green #0acf83 / orange #f24e1e / purple #a259ff / red #ff7262 / blue #1abcfe`，accent 按 section 轮换，禁止整页单色
- 圆角：卡片 12px+、按钮/输入 8px、pill 999px；卡片 hover `0 8px 24px rgba(15,15,20,.08)` 软阴影
- 字体：标题 Whyte Inktrap（fallback PP Editorial New）500、正文 Inter 400 16px、UI Inter 500、mono Söhne Mono；scale 13/15/17/20/24/32/44/64/88
- 布局：1280px max、32px gutter、8px 基准网格、section 背景用 10% 品牌色 tint 交替
- 输入 focus：2px brand-hue ring；明色主题为默认（禁止默认暗色）
- 文案：像"乐于助人的朋友"（中文语境下保持同样的语气）
- 响应式：<768px section 堆叠，标题 88→32
- 无 Whyte Inktrap / PP Editorial / Söhne Mono 网络字体授权时：标题用 `Inter 600 tight tracking` 或系统衬线 fallback，mono 用 `ui-monospace`——在 `tokens.css` 集中定义，留换字体注释

## Global Constraints

- 沿用 Plan 1/2 接口：`createApp(cfg, deps?)`、`AuthQueue/PrintQueue/BalloonService/TeamStore/JsonStore/SseBus`、`Deps` 可选注入模式；全部既有测试保持绿（当前 109 pass）。
- `apps/admin` 构建输出 `apps/server/static`，vite `base: '/cxtool/'`；服务器静态托管路径守卫改用 `join` + 前缀带分隔符校验，并按扩展名返回 Content-Type。
- `/admin/api/*` 全部路由（含 Plan 2 已有的）必须过管理员鉴权中间件（本次补齐，解除 Plan 2 的延期裁定）；登录端点 `POST /admin/api/login` 本身豁免；SSE `/admin/api/events` 用 query token 校验。
- 新依赖仅限纯 JS 包；现场离线；bun 兼容。
- 后端不引入新数据库；admin 凭据沿用 `cfg.admin { username, passwordHash }`（bcrypt/argon 校验如哈希非空，纯文本哈希字段值为空时拒绝登录——需在 sample 配置说明生成方式）。
- 删除 `xcpcio/`：从仓库、根 `pnpm-workspace.yaml`、`.gitignore`、CI 同步移除；Java 版（src/、vue/）不动。
- 所有前端文案中文，语气友好；页面不做默认暗色。

## Review Focus

- `/admin/api/*` 在无 token 时仍可访问（鉴权中间件漏挂某条新路由）→ Task 3 的全路由 401 扫描测试。
- 静态托管路径穿越（`..%2f` 编码绕过前缀检查）→ Task 7 的穿越用例（含 URL 编码形态）。
- 登录爆破无速率限制 → Task 3 的简单限速（同 IP 每分钟 5 次，内存计数即可）。
- 构建产物哈希文件名与 Content-Type 不匹配导致前端加载失败 → Task 7 的产物冒烟测试（index.html + 一个带 hash 的 js 资源 200 + 正确 MIME）。
- Element Plus 主题覆盖不生效导致默认蓝色残留 → Task 2 的视觉 token 快照测试（CSS 变量断言）。

---

### Task 1: apps/admin 脚手架

**Files:**
- Create: `apps/admin/`（Vite + Vue3 + TS：`package.json`、`vite.config.ts`、`tsconfig.json`、`index.html`、`src/main.ts`、`src/App.vue`、`src/router/index.ts`、`src/stores/session.ts`）
- Modify: 根 `pnpm-workspace.yaml` 无需改（`apps/*` 已覆盖）；`apps/server/.gitignore` 或根 `.gitignore` 追加 `apps/admin/dist` 说明性条目（实际产物出 server/static，已忽略）
- Test: `apps/admin/src/App.test.ts`（bun test 挂载冒烟：App 渲染出导航壳）

**Interfaces:**
- Produces: `apps/admin` 可 `bun run dev`（vite dev server，端口 5173，proxy `/cxtool` → `http://localhost:8080`）与 `bun run build`（`outDir: '../server/static'`，`base: '/cxtool/'`，`emptyOutDir: true`）。
- Produces: router 路由表（路径先占位，页面组件后续任务填充）：`/login`、`/`（总览）、`/auth-tasks`、`/jobs`（打印+气球）、`/teams`。
- Produces: `stores/session.ts` Pinia store：`token`（localStorage 持久化）、`login(username, password)`、`logout()`；axios/fetch 封装 `apiFetch(path, opts)` 自动带 `Authorization: Bearer <token>` 并在 401 时跳 `/login`。
- Element Plus 按需引入（`unplugin-vue-components` + `ElementPlusResolver`）。

- [ ] **Step 1: 脚手架 + 配置 vite/tsconfig**（outDir/base/devServer proxy 按上述精确值）
- [ ] **Step 2: 写 App 冒烟测试并确认 FAIL**（`bun test` in apps/admin）
- [ ] **Step 3: 实现最小 App.vue + router + session store，确认 PASS**
- [ ] **Step 4: `bun run build` 产物落到 `apps/server/static`（检查 index.html 生成）**
- [ ] **Step 5: Commit** `feat(admin): vite scaffold with router, session store, element plus`

### Task 2: 设计令牌与布局壳（DESIGN-md.md 落地）

**Files:**
- Create: `apps/admin/src/styles/tokens.css`（全部 CSS 变量 + 字体 stack + 字阶）
- Create: `apps/admin/src/styles/main.css`（基础 reset + Element Plus 主题变量桥接）
- Create: `apps/admin/src/layouts/AdminLayout.vue`（顶部导航 + 页面容器，1280px max、32px gutter、8px 网格、section tint 交替）
- Modify: `apps/admin/src/App.vue`、router（布局壳套用）
- Test: `apps/admin/src/styles/tokens.test.ts`（读 tokens.css 断言五个 brand 变量与圆角/阴影值存在）

**Interfaces:**
- Produces: CSS 变量契约（后续所有页面只用这些变量，禁止硬编码色值）：`--brand-green/orange/purple/red/blue`、`--bg`、`--bg-alt`、`--text`、`--text-muted`、`--border`、`--radius-card: 16px`、`--radius-control: 8px`、`--radius-pill: 999px`、`--shadow-card: 0 8px 24px rgba(15,15,20,.08)`、字阶 `--text-13/15/17/20/24/32`。
- Produces: Element Plus 桥接：`--el-color-primary` 指向当前 section accent、`--el-border-radius-base: 8px`、success/warning/danger 映射到 brand-green/orange/red；focus ring 2px。
- Produces: `AdminLayout.vue` 布局壳：品牌色 logo 点 + 导航 pill（当前页 accent 轮换：总览 purple、认证 green、任务 orange、队伍 blue）、页头 44px 字阶标题、friendly 微文案。

- [ ] **Step 1: 写 tokens.test.ts 断言并确认 FAIL**
- [ ] **Step 2: 实现 tokens.css / main.css / AdminLayout.vue，确认 PASS**
- [ ] **Step 3: `bun run build` 成功；人工目检 dev 页面与设计标准逐条对照（圆角/色轮换/tint 交替）**
- [ ] **Step 4: Commit** `feat(admin): design tokens from DESIGN.md and layout shell`

### Task 3: 管理员鉴权（服务器 + 登录页）

**Files:**
- Create: `apps/server/src/admin/auth.ts`
- Modify: `apps/server/src/server.ts`（登录路由 + `/admin/api/*` 鉴权中间件 + SSE query token）、`apps/server/src/config.ts`（如需 `admin.sessionTtlSeconds`，默认 8h）
- Create: `apps/admin/src/pages/LoginPage.vue`
- Test: `apps/server/src/admin/auth.test.ts`、`apps/admin/src/pages/LoginPage.test.ts`

**Interfaces:**
- Consumes: `cfg.admin { username, passwordHash }`、`signTeamToken/verifyTeamToken`（复用 JWT 基建，claim 加 `role: "admin"`）。
- Produces: `POST /admin/api/login { username, password }` → 校验（`passwordHash` 为空 → 401 fixed message；bcryptjs 纯 JS 校验，`bun add bcryptjs`）→ 签发 admin JWT（cookie `cxtool-admin`，HttpOnly + SameSite=Strict + `Path=${contextPath}/`，同时返回 body token 供 SSE query 用）→ 限速：同 IP 每分钟 5 次失败后 429（内存 Map，10 分钟窗口）。
- Produces: 中间件：除 `POST /admin/api/login` 外所有 `/admin/api/*` 校验 `Authorization: Bearer` 或 cookie `cxtool-admin`，失败 401；`GET /admin/api/events` 额外接受 `?token=` query。**Plan 2 的全部 admin 路由自动被覆盖**。
- Produces: `LoginPage.vue`：卡片式登录（12px 圆角、purple accent、2px focus ring、friendly 错误文案），成功后跳 `/`。

- [ ] **Step 1: 写失败测试**：错误密码 401（限速前）；passwordHash 为空 401；正确凭据 200 + token 可验证 role=admin；未带 token 的 `/admin/api/auth-tasks`、`/admin/api/print-tasks`、`/admin/api/balloon-tasks`、`/admin/api/teams`、`/admin/api/teams/sync`、`/admin/api/import-excel` 全部 401（扫描列表写全）；第 6 次失败登录 429；`?token=` 的 SSE 连接 200。
- [ ] **Step 2: 确认 FAIL，实现服务器端，确认 PASS**
- [ ] **Step 3: 写 LoginPage.vue（含组件测试：提交触发 session.login、401 显示 friendly 文案），确认 PASS**
- [ ] **Step 4: 全量测试绿 + tsc clean + build 成功**
- [ ] **Step 5: Commit** `feat: admin auth with rate limit and login page`

### Task 4: 总览页 + 认证任务审批页

**Files:**
- Create: `apps/admin/src/pages/DashboardPage.vue`、`apps/admin/src/pages/AuthTasksPage.vue`
- Test: `apps/admin/src/pages/AuthTasksPage.test.ts`、`DashboardPage.test.ts`

**Interfaces:**
- Consumes: `GET /admin/api/auth-tasks?status=`、`POST /admin/api/auth-tasks/:id/approve|reject`、`GET /admin/api/events`（SSE，`?token=`）、Task 3 鉴权。
- Produces: DashboardPage：四张统计卡（待审认证/待打任务/待发气球/队伍数，各用不同 brand hue，12px 圆角 + hover 软阴影），friendly 空态文案；数据来自各 list API 聚合。
- Produces: AuthTasksPage：任务表（Element Plus table，pill 状态标签 pending=orange/approved=green/rejected=red/auto-done=blue），行内批准/拒绝按钮，SSE 实时刷新（去重闪烁），friendly 确认微文案。

- [ ] **Step 1: 写失败组件测试**（mock apiFetch：渲染任务行、点击批准调用 API、SSE push 后列表更新）
- [ ] **Step 2: 实现两页，确认 PASS；build 成功**
- [ ] **Step 3: Commit** `feat(admin): dashboard and auth task approval pages`

### Task 5: 打印/气球任务页（Jobs）

**Files:**
- Create: `apps/admin/src/pages/JobsPage.vue`
- Test: `apps/admin/src/pages/JobsPage.test.ts`

**Interfaces:**
- Consumes: print-tasks 与 balloon-tasks 的 list/ack 路由、SSE。
- Produces: JobsPage 双 Tab（orange accent）：打印任务表（location/team/filename/状态 pill、标记已打/失败按钮）、气球任务表（problem label/team/location、标记已送按钮）；两个 Tab 的 SSE 事件分流刷新；空态插画占位（简单几何 SVG，2-3 个 brand hue，扁平）。

- [ ] **Step 1: 写失败组件测试**（双 Tab 渲染、ack 调 API、SSE 刷新）
- [ ] **Step 2: 实现，确认 PASS；build 成功**
- [ ] **Step 3: Commit** `feat(admin): print and balloon jobs page`

### Task 6: 队伍管理页

**Files:**
- Create: `apps/admin/src/pages/TeamsPage.vue`
- Test: `apps/admin/src/pages/TeamsPage.test.ts`

**Interfaces:**
- Consumes: `GET /admin/api/teams`、`POST /admin/api/teams/sync`、`POST /admin/api/teams/import-excel`。
- Produces: TeamsPage（blue accent）：队伍表（icpc_id/name/members/location，无密码列）、"从 DOMjudge 同步"按钮（loading 态 + 结果 toast）、Excel 上传（拖拽区 + 模板说明微文案，展示 imported/skipped 结果）、friendly 错误 toast。

- [ ] **Step 1: 写失败组件测试**（渲染列表、sync 按钮调 API、上传后展示 imported/skipped）
- [ ] **Step 2: 实现，确认 PASS；build 成功**
- [ ] **Step 3: Commit** `feat(admin): teams management page with excel import`

### Task 7: 静态托管加固 + 生产冒烟

**Files:**
- Modify: `apps/server/src/server.ts`（静态托管：`join(STATIC_DIR, rel)` + `startsWith(STATIC_DIR + sep)` 守卫、按扩展名 Content-Type 映射（html/js/css/svg/png/ico/json/woff2）、SPA fallback 到 index.html）
- Modify: `apps/server/src/index.ts`（如需静态目录常量调整）
- Test: `apps/server/src/server.test.ts` 追加冒烟用例

**Interfaces:**
- Produces: 对构建产物（hash 文件名）的正确 MIME 服务；SPA 路由（/cxtool/login 等深链）fallback index.html；路径守卫拒绝 `../` 与 URL 编码形态。

- [ ] **Step 1: 写失败测试**：`/../secret` 与 `%2e%2e` 形态 403/404；index.html 200 + `text/html`；`.js` 产物 200 + `application/javascript`（fixture 文件）；深链 `/cxtool/login` 返回 index.html。
- [ ] **Step 2: 实现，确认 PASS；`bun run build`（admin）后端到端冒烟：起服务 curl `/cxtool/` 返回管理端 HTML**
- [ ] **Step 3: Commit** `feat(server): hardened static hosting with spa fallback and mime map`

### Task 8: 移除 xcpcio + 部署与 CI

**Files:**
- Delete: `xcpcio/` 整目录
- Modify: `pnpm-workspace.yaml`（移除 xcpcio 条目）、`.gitignore`（清理 xcpcio 段）、`.github/workflows/build-jar.yml`（移除 xcpcio 构建步骤）、`README.md`（目录表与遗留说明更新）
- Create: `.github/workflows/ci.yml`（新 TS 侧 CI：`apps/admin` build → `apps/server` `bun test` + tsc → 上传 static 产物）
- Create: `script/deploy/`（`deploy.md` 部署说明：目标机装 Bun → `bun install`（apps/server + apps/admin）→ build admin → `bun run server`；Windows/Linux 两节）与可选 `start.sh`/`start.ps1`

**Interfaces:**
- Produces: CI 在 push 到 main 时跑完整 TS 测试链；Java workflow 保留但不再依赖 xcpcio。

- [ ] **Step 1: 删除 xcpcio 并清理引用（grep 确认无残留 import/脚本引用）**
- [ ] **Step 2: 写 ci.yml 与部署文档/脚本**
- [ ] **Step 3: 全量 `bun run test` 绿 + admin build 成功**
- [ ] **Step 4: Commit** `chore: remove xcpcio, add ts CI and deploy scripts`

---

## 完成定义（Plan 3）

- `bun run test`（apps/server）与 `bun test`（apps/admin）全绿；`bunx tsc --noEmit` 干净。
- 端到端冒烟：起服务 → `/cxtool/` 返回管理端登录页 → 登录 → 各页面 API 正常 → `/cxtool/dj/*` 代理链路不受影响（既有集成测试覆盖）。
- 仓库无 xcpcio；CI 覆盖 TS 全链路；`script/deploy/deploy.md` 足以在 Windows/Linux 新机上完成部署。
