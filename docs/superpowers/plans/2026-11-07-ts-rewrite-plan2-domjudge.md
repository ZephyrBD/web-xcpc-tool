# Plan 2: DOMjudge 集成 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 apps/server 具备完整 DOMjudge 集成：API 客户端、认证放行（verify → token → 全量反代）、打印回调与队列、气球任务、队伍导入。

**Architecture:** `domjudge/` 模块封装上游 API 客户端；`/dj/*` 全量反向代理在 JWT 校验通过后转发（cookie/Host 透传）；打印回调由 `org.domjudge.print-token` 头鉴权、PDF 落 `pdf/` 目录并入队 + SSE；气球服务轮询 judgings 生成气球任务；队伍从 DOMjudge API 拉取 + Excel 导入密码。

**Tech Stack:** Bun + Hono（`hono/proxy` 的 `proxy` 助手做流式转发）、zod、Excel 解析用 `xlsx`（纯 JS，无原生编译）。

**Spec:** `docs/superpowers/specs/2026-11-07-ts-bun-rewrite-design.md`（注意：外部榜单功能已停止提供，本计划无 board 数据路由）

## Global Constraints

- 沿用 Plan 1 全部接口：`loadConfig/Config`、`JsonStore/setDataDir`、`SecretBox/ensureKeyFile`、`signTeamToken/verifyTeamToken`（async）、`identifyClient/ClientFingerprint`、`FingerprintCapture`、`AuthQueue/AuthTask/SseBus`、`createApp(cfg, deps?)`（路由已挂在 `/cxtool` basePath 下，`deps.server.requestIP` 已接）。
- Bun 兼容 API；新增依赖仅限纯 JS 包（`xlsx`）；现场离线运行。
- DOMjudge 响应流式透传，不缓冲大文件；打印 PDF 保存到 `data/pdf/`（`./gradlew clean` 时代的 `pdf/` 目录语义废弃）。
- 所有面向队伍的代理路由必须先过 `verifyTeamToken`，失败返回 401 JSON；打印回调只认 `org.domjudge.print-token` 头（值等于 `cfg.print.token`）。
- 外部硬契约：DOMjudge 的打印命令回调路径与 header 名、teams JSON 导入格式（见 spec/README）不可改动；其余路由可自由设计。
- 测试用 mock 上游（Hono 测试应用挂本地端口或 `fetch` mock），不依赖真实 DOMjudge。

## Review Focus

- 未带合法 JWT 的 `/dj/*` 请求被代理到上游（信息泄露）→ Task 3 的 401 用例。
- 打印回调在无/错 `print-token` 时仍写文件 → Task 4 的拒绝用例。
- 上游 5xx/超时导致代理进程崩溃或挂死（流式中断处理）→ Task 3 的上游错误用例。
- Excel 导入把密码明文写入日志/响应 → Task 6 的导入脱敏用例。
- balloon 轮询在上游不可用时空转刷日志 → Task 5 的轮询退避测试。

---

### Task 1: DOMjudge API 客户端

**Files:**
- Create: `apps/server/src/domjudge/client.ts`
- Modify: `apps/server/src/config.ts`（`domjudge` 段扩展为 `{ baseUrl, adminUser, adminPassword }`，均带默认值 ""）
- Test: `apps/server/src/domjudge/client.test.ts`

**Interfaces:**
- Produces: `class DjClient { constructor(cfg: Config["domjudge"]); getTeams(contestId: string): Promise<DjTeam[]>; getContests(): Promise<DjContest[]>; getSubmissions(contestId: string): Promise<DjSubmission[]>; getJudgings(contestId: string, since?: string): Promise<DjJudging[]> }`。类型：`DjTeam = { id, icpc_id?, name, display_name?, organization_id?, members?, location?: { description? } }`（对齐 README 的队伍 JSON）；`DjJudging = { id, submission: string, judgement_type_id, verified?, start_time? }`。
- Produces: 构造内部 `fetch` 包装：Basic Auth（adminUser:adminPassword），相对路径拼到 `baseUrl`，非 2xx 抛 `DjApiError(url, status)`；上游不可达抛同一错误类型。
- Consumes: `Config`（Task 2/Plan 1）。

- [ ] **Step 1: 写失败测试**（用 `mock.module` 或注入 `fetchImpl` 构造参数 mock 上游）：`getTeams` 正确拼 URL + Basic Auth 头并解析 JSON 数组；404 抛 `DjApiError` 且 message 含 URL 与 status；连接拒绝抛 `DjApiError`。
- [ ] **Step 2: 确认 FAIL**（`bun test src/domjudge/client.test.ts`）
- [ ] **Step 3: 实现** client.ts；config.ts 扩展 domjudge 段（保持向后默认 ""）。
- [ ] **Step 4: 全量测试 PASS + tsc clean**
- [ ] **Step 5: Commit** `feat(server): DOMjudge API client with basic auth`

### Task 2: 认证放行（verify → token）

**Files:**
- Create: `apps/server/src/domjudge/verify.ts`
- Modify: `apps/server/src/server.ts`（挂路由）
- Test: `apps/server/src/domjudge/verify.test.ts`

**Interfaces:**
- Consumes: `AuthQueue`（approved/auto-done 任务含 examNum+clientId）、`signTeamToken/verifyTeamToken`、`identifyClient`、`Config`。
- Produces: 路由 `GET /dj/verify`（query: `examNum`，header 携带识别指纹）——逻辑：identifyClient 命中 → 查 AuthQueue 中该 examNum+clientId 的 approved/auto-done 任务 → 存在则 `signTeamToken(secret, ttl, examNum)` 并 302 重定向到 `cfg.domjudge.baseUrl + "/dj/"`（token 放 `Set-Cookie: cxtool-token=...; Path=/dj; HttpOnly`）；未识别或未批准 → 403 JSON `{ ok: false, reason }`。这是队伍进 DOMjudge 的唯一入口。
- Produces: `verifyClient(req, queue, cfg): Promise<{ ok: true; token: string } | { ok: false; reason: string }>`（纯函数，路由是其薄壳）。

- [ ] **Step 1: 写失败测试**：预置 auto-done 任务 + 合法 UA（`QtWebEngine/6.5.3`）→ ok 且 token 可 `verifyTeamToken` 还原 examNum；无任务 → 403 reason "not approved"；UA 不匹配任何策略 → 403 reason "illegal client"。
- [ ] **Step 2: 确认 FAIL**
- [ ] **Step 3: 实现** verify.ts + server.ts 挂路由。
- [ ] **Step 4: 全量 PASS + tsc clean**
- [ ] **Step 5: Commit** `feat(server): client verify route issuing team tokens`

### Task 3: 全量反向代理 /dj/*

**Files:**
- Create: `apps/server/src/domjudge/proxy.ts`
- Modify: `apps/server/src/server.ts`（挂 `ALL /dj/*`，在 verify 路由之后注册避免自遮蔽）
- Test: `apps/server/src/domjudge/proxy.test.ts`

**Interfaces:**
- Consumes: `verifyTeamToken`、Task 1 的 `Config["domjudge"].baseUrl`。
- Produces: 路由 `ALL /dj/*`——校验 cookie `cxtool-token`（无/无效 → 401 JSON）；有效则用 `hono/proxy` 的 `proxy()` 把请求转发到 `<baseUrl>/<剩余路径>`，透传 method/headers/body/query（剔除 `Host`，改写 cookie domain 不需要——同源），响应原样流式返回；上游抛错/不可达 → 502 JSON，不崩溃。token 校验失败不触达上游。
- Produces: `proxyFilter(c): string | null`（返回剩余路径或 null，供测试）。

- [ ] **Step 1: 写失败测试**（起一个真实本地 Bun.serve 当假上游，监听随机端口）：合法 token → 上游收到原 method/path/body 且响应透传；无 cookie → 401 且**假上游收到 0 个请求**；篡改 token → 401；上游不可达（baseUrl 指向未监听端口）→ 502。
- [ ] **Step 2: 确认 FAIL**
- [ ] **Step 3: 实现** proxy.ts + server.ts 挂载。
- [ ] **Step 4: 全量 PASS + tsc clean**
- [ ] **Step 5: Commit** `feat(server): token-gated streaming reverse proxy for DOMjudge`

### Task 4: 打印回调 + 打印队列

**Files:**
- Create: `apps/server/src/print/queue.ts`
- Create: `apps/server/src/print/callback.ts`
- Modify: `apps/server/src/server.ts`（挂路由 + SSE 推送）、`apps/server/src/config.ts`（新增 `print: { token: string }`，默认 ""）
- Test: `apps/server/src/print/queue.test.ts`、`apps/server/src/print/callback.test.ts`

**Interfaces:**
- Consumes: `JsonStore`、`SseBus`、`Config`。
- Produces: `type PrintTask = { id: string; location: string; teamName: string; teamId: string; originalFilename: string; status: "pending" | "printed" | "failed"; pdfPath: string; createdAt: string }`；`class PrintQueue { add(task: Omit<PrintTask,"id"|"status"|"createdAt">): PrintTask; ack(id: string, status?: "printed" | "failed"): PrintTask | null; list(status?): PrintTask[]; onChange(cb): () => void }`（JsonStore 持久化，模式同 AuthQueue）。
- Produces: 路由 `POST /dj/print`（DOMjudge 打印回调目标，路径对齐 Java 版语义）——校验 header `org.domjudge.print-token === cfg.print.token`（不等 → 403 且**不落任何文件**）；multipart 表单字段 `location/teamname/teamid/original/file(PDF)`；PDF 字节写 `data/pdf/<uuid>.pdf`，任务入队，SSE channel `admin` 推 `{ event: "print-task", data }`。另挂 `GET /admin/api/print-tasks`、`POST /admin/api/print-tasks/:id/ack`。
- PDF 存储用 `node:fs` 直写（大二进制不走 JsonStore）。

- [ ] **Step 1: 写失败测试**：正确 token + multipart → 文件存在且非空、任务 status pending、SSE 收到事件；无 token → 403、pdf 目录无新文件；错误 token → 403；ack 后状态变更。
- [ ] **Step 2: 确认 FAIL**
- [ ] **Step 3: 实现** queue.ts + callback.ts + 挂载。
- [ ] **Step 4: 全量 PASS + tsc clean**
- [ ] **Step 5: Commit** `feat(server): DOMjudge print callback with token auth and print queue`

### Task 5: 气球任务服务

**Files:**
- Create: `apps/server/src/balloon/service.ts`
- Modify: `apps/server/src/server.ts`（挂路由）、`apps/server/src/config.ts`（新增 `balloon: { pollIntervalSeconds: number }`，默认 30）
- Test: `apps/server/src/balloon/service.test.ts`

**Interfaces:**
- Consumes: `DjClient.getJudgings`/`getSubmissions`、`JsonStore`、`SseBus`。
- Produces: `type BalloonTask = { id: string; contestId: string; problemLabel: string; teamName: string; location: string | null; status: "pending" | "delivered"; createdAt: string }`；`class BalloonService { constructor(deps: { client: DjClient; store: JsonStore<BalloonTask[]>; bus: SseBus; contestId: string; pollIntervalSeconds: number; fetchImpl?: typeof fetch }); start(): void; stop(): void; pollOnce(): Promise<number>; ack(id: string): BalloonTask | null; list(status?): BalloonTask[] }`——`pollOnce` 拉最新 judgings，对 verdict 为正确（judgement_type_id 匹配 DOMjudge "correct" 类型的 id，通过 `getJudgementTypes` 补充到 client）且无对应 balloon 记录的 submission 生成任务 + SSE 推送，返回新建数量；`start` 用 `setTimeout` 链式轮询，`stop` 可停；**连续失败时轮询间隔翻倍（上限 10 倍），成功后恢复**。
- Produces: client.ts 追加 `getJudgementTypes(contestId): Promise<Array<{ id, sorting_key? }>>`（"correct" 用 sorting_key 或 id 语义，实现时以 DOMjudge API 文档为准，测试里 mock 决定）。
- Produces: 路由 `GET /admin/api/balloon-tasks`、`POST /admin/api/balloon-tasks/:id/ack`。
- problemLabel 从 submissions→problems 映射：client 追加 `getProblems(contestId): Promise<Array<{ id, label, name }>>`。

- [ ] **Step 1: 写失败测试**：mock 上游两条 judging（一条 correct 一条 wrong）→ pollOnce 返回 1、生成任务、SSE 收到；同一 submission 再 poll 不重复；连续两次 fetchImpl 抛错后第三次成功 → 第三次间隔 ≥ 2 倍配置值（用注入计时器或可配置 sleep 函数测退避）；ack 状态流转。
- [ ] **Step 2: 确认 FAIL**
- [ ] **Step 3: 实现**（client.ts 两个追加方法 + service.ts + 挂载）。
- [ ] **Step 4: 全量 PASS + tsc clean**
- [ ] **Step 5: Commit** `feat(server): balloon task service with polling backoff and SSE`

### Task 6: 队伍导入（Excel + DOMjudge 拉取）

**Files:**
- Create: `apps/server/src/teams/import.ts`
- Modify: `apps/server/src/server.ts`（挂路由）
- Test: `apps/server/src/teams/import.test.ts`
- Dependency: `bun add xlsx`

**Interfaces:**
- Consumes: `DjClient.getTeams`、`TeamStore.setPassword/list`（Plan 1）、`xlsx`。
- Produces: `importTeamsFromExcel(buffer: Buffer, teams: DjTeam[]): Promise<{ imported: number; skipped: number }>`——Excel 两列 `ICPC_ID | PASSWORD`（表头行匹配，大小写不敏感）；密码经 `TeamStore.setPassword` 加密落盘；icpc_id 不在 teams 列表中的行计数为 skipped（不拒绝整个文件）。
- Produces: `syncTeamsFromDomjudge(client: DjClient, contestId: string): Promise<number>`——拉取 teams 全量写入 `JsonStore<DjTeam[]>`（teams.json），返回数量。
- Produces: 路由 `POST /admin/api/teams/import-excel`（multipart，file 字段）、`POST /admin/api/teams/sync`（body: contestId）、`GET /admin/api/teams`（返回队伍列表，**响应与日志中绝不出现 password 字段**）。
- 日志脱敏：import 函数任何输出不得包含密码值。

- [ ] **Step 1: 写失败测试**：用 xlsx 生成内存 Excel buffer → import 后 `getPassword(icpcId)` 还原明文；未知 icpc_id 计 skipped；`GET /admin/api/teams` 响应 JSON.stringify 不含明文密码；sync 用 mock client 返回数量。
- [ ] **Step 2: 确认 FAIL**
- [ ] **Step 3: 实现**。
- [ ] **Step 4: 全量 PASS + tsc clean**
- [ ] **Step 5: Commit** `feat(server): team import via Excel and DOMjudge sync`

### Task 7: 总装配 + DoD 验证

**Files:**
- Modify: `apps/server/src/index.ts`（装配 DjClient/PrintQueue/BalloonService 进 deps；BalloonService.start 生命周期跟随 Bun.serve）
- Modify: `apps/server/src/server.ts`（`Deps` 扩展：`djClient?`, `printQueue?`, `balloonService?`，缺省时自行构造并传递给需要的路由处理器）
- Test: `apps/server/src/server.test.ts`（追加集成用例）

**Interfaces:**
- Consumes: 全部前序任务。
- Produces: 完整可运行的单进程服务器：`bun run server` 后 verify → token → `/dj/*` 反代全链路可用（配置真实 DOMjudge 时），打印/气球/队伍 API 挂在 `/cxtool` 下。
- DoD（控制器实测）：mock 上游下 `GET /dj/verify`（带 QtWebEngine UA + auto-done 任务）→ 302 带 cookie → `GET /dj/anything`（带 cookie）→ 代理命中假上游；`POST /dj/print`（带 token）→ 文件落盘 + 任务入队。

- [ ] **Step 1: 写失败集成测试**（上述 DoD 链路，用假上游 + 内存依赖）。
- [ ] **Step 2: 确认 FAIL**
- [ ] **Step 3: 装配 index.ts/server.ts 的 Deps 扩展与生命周期（SIGINT 时 balloonService.stop()）**。
- [ ] **Step 4: 全量 PASS + tsc clean；控制器实测 DoD**
- [ ] **Step 5: Commit** `feat(server): assemble domjudge integration into single-process server`
