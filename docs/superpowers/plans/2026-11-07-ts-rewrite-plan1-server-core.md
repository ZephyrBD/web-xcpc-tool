# Plan 1: Monorepo 脚手架 + Bun 后端核心 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 建立 pnpm monorepo，并实现新后端的核心层：配置、JSON 原子存储、凭据加密、JWT、OMS 客户端识别策略链（含指纹采集）、认证任务队列与 SSE 推送、HTTP 服务骨架。

**Architecture:** Bun + Hono 单进程。所有持久化走 `data/` 下 JSON 文件（tmp+rename 原子写）。OMS 识别为策略链模式，命中后进入既有"队列→审批→SSE"流程。全部模块可独立单测（bun test），HTTP 层用 Hono 的 `app.request()` 内存测试，不占端口。

**Tech Stack:** Bun 1.x（运行时/测试/打包）、Hono（HTTP）、zod（配置与契约校验）、node:crypto（AES-256-GCM、密钥生成）。

**Spec:** `docs/superpowers/specs/2026-11-07-ts-bun-rewrite-design.md`

## Global Constraints

- 运行时只用 Bun 兼容 API（`node:` 前缀内置模块可用）；禁止依赖需要原生编译的 npm 包（现场离线）。
- 测试框架统一 `bun test`，测试文件与源码同目录 `*.test.ts`。
- 现场隔离网络：不得有任何启动时外网请求。
- 新代码不引入数据库；`data/` JSON 文件写入必须 tmp+rename 原子替换。
- 管理端口默认 `8080`，上下文路径 `/cxtool`（延续现状，ProxyPreserveHost 语义由反代任务处理，属 Plan 2）。
- 所有密码字段（icpc_id→password 映射值）落盘前必须经过 Task 4 的加密函数。

## Review Focus

- 队伍密码明文落盘：任何 store 写路径绕过加密函数都算事故 → Task 4/5 的 roundtrip 测试 + Task 5 的"写后读文件确认无明文"测试。
- JSON 写入中途崩溃留下损坏文件 → Task 3 的"tmp 残留时启动可恢复"测试。
- 新版 OMS（QtWebEngine 默认 UA）被误判为非法客户端 → Task 6 的 `QtWebEngine/6.5.3` UA 用例。
- 指纹采集把队伍密码头写进日志 → Task 6 的采集脱敏测试（过滤 `cookie`/`authorization` 头）。
- JWT 过期/篡改 token 被接受 → Task 5 的过期与篡改用例。

---

### Task 1: Monorepo 脚手架

**Files:**
- Create: `package.json`（root，注意与现有 Gradle 项目共存——新代码进 `apps/`、`packages/`，Java 部分不动）
- Create: `pnpm-workspace.yaml`（`packages: ["apps/*", "packages/*", "xcpcio"]`）
- Create: `apps/server/package.json`、`apps/server/tsconfig.json`
- Create: `apps/server/src/index.ts`（临时入口，仅 `console.log`）
- Modify: `.gitignore`（追加 `data/`、`node_modules/` 根级条目）

**Interfaces:**
- Produces: `cd apps/server && bun test` 可运行的空测试环境；后续任务的所有路径基于 `apps/server/`。

- [ ] **Step 1: 写 root `package.json` 与 `pnpm-workspace.yaml`**，root scripts 含 `"server": "bun run --cwd apps/server src/index.ts"`、`"test": "bun test apps/server"`。
- [ ] **Step 2: 初始化 apps/server**：`package.json`（`"type": "module"`，依赖 `hono`、`zod`）、`tsconfig.json`（`strict: true`、`module: esnext`、`types: ["bun"]`）、空 `src/index.ts`。
- [ ] **Step 3: 验证**：`pnpm install && bun run test` 退出码 0（无测试文件时 bun test 报"no tests"，需先放一个 `src/smoke.test.ts` 断言 `1+1===2`）。
- [ ] **Step 4: Commit** `chore: scaffold pnpm monorepo with bun server app`

### Task 2: 配置模块

**Files:**
- Create: `apps/server/src/config.ts`
- Test: `apps/server/src/config.test.ts`

**Interfaces:**
- Produces: `loadConfig(path: string): Config`（同步读 JSON + zod 校验，缺字段用默认值）；`type Config` 含字段：`port: number`（默认 8080）、`contextPath: string`（默认 `/cxtool`）、`domjudge: { baseUrl: string }`、`jwt: { secret: string; ttlSeconds: number }`、`oms: { strategies: string[]; uaRegexes: string[]; customHeader?: { name: string; value: string }; capture: boolean }`、`admin: { username: string; passwordHash: string }`。
- Produces: `writeDefaultConfig(path: string): void`（首次启动生成）。

- [ ] **Step 1: 写失败测试**：缺省文件时 `loadConfig("/tmp路径不存在的文件")` 返回默认值（port 8080、contextPath `/cxtool`、`oms.capture === false`）；写入一个 port=9999 的 JSON 后 load 返回 9999；port 传字符串 `"x"` 时抛 zod 错误。
- [ ] **Step 2: `bun test src/config.test.ts` 确认 FAIL**
- [ ] **Step 3: 实现** config.ts（zod schema + `safeParse`，可选字段填默认值）。
- [ ] **Step 4: 测试 PASS**
- [ ] **Step 5: Commit** `feat(server): zod-validated JSON config with defaults`

### Task 3: JSON 原子存储

**Files:**
- Create: `apps/server/src/store/store.ts`
- Test: `apps/server/src/store/store.test.ts`

**Interfaces:**
- Produces: `class JsonStore<T> { constructor(filePath: string, defaultValue: T); load(): T; save(value: T): void; update(fn: (cur: T) => T): T }`。`save` = 写 `filePath + ".tmp"` 后 `renameSync` 覆盖；`load` 时若主文件缺失但 tmp 存在则用 tmp 内容恢复。
- Produces: 模块级 `setDataDir(dir: string)` 前缀解析（store 接受相对路径时挂到 dataDir 下）。

- [ ] **Step 1: 写失败测试**（用 `bun` 临时目录 fixture）：save 后文件存在且内容可 JSON.parse；update 原子性——mock rename 抛错后主文件仍是旧值；主文件损坏（非法 JSON）时 load 抛带文件名的 Error；仅 tmp 存在时 load 恢复 tmp 内容。
- [ ] **Step 2: 确认 FAIL**
- [ ] **Step 3: 实现** store.ts（约 60 行）。
- [ ] **Step 4: 测试 PASS**
- [ ] **Step 5: Commit** `feat(server): atomic JSON store with tmp-recovery`

### Task 4: 凭据加密

**Files:**
- Create: `apps/server/src/store/secretbox.ts`
- Test: `apps/server/src/store/secretbox.test.ts`

**Interfaces:**
- Produces: `class SecretBox { constructor(keyHex: string); encrypt(plain: string): string; decrypt(payload: string): string }`，payload 格式 `v1:<iv_hex>:<ciphertext_hex>:<tag_hex>`（AES-256-GCM）。
- Produces: `ensureKeyFile(path: string): string`（不存在则生成 32 字节随机 hex 写入，返回 hex；存在则读取）。

- [ ] **Step 1: 写失败测试**：roundtrip（中英文 + 特殊字符）；用错误 key decrypt 抛错；payload 格式前缀不对抛错；`ensureKeyFile` 两次调用返回同一 hex 且文件权限内可读。
- [ ] **Step 2: 确认 FAIL**
- [ ] **Step 3: 实现**（node:crypto `createCipheriv('aes-256-gcm')`）。
- [ ] **Step 4: 测试 PASS**
- [ ] **Step 5: Commit** `feat(server): AES-GCM secretbox for credential fields`

### Task 5: JWT + 密码字段存储接入

**Files:**
- Create: `apps/server/src/auth/token.ts`
- Create: `apps/server/src/store/teams.ts`
- Test: `apps/server/src/auth/token.test.ts`、`apps/server/src/store/teams.test.ts`

**Interfaces:**
- Consumes: Task 3 `JsonStore`、Task 4 `SecretBox`。
- Produces: `signTeamToken(secret: string, ttlSeconds: number, examNum: string): string` 与 `verifyTeamToken(secret: string, token: string): { examNum: string } | null`（过期/篡改返回 null，不抛）。
- Produces: `class TeamStore { setPassword(icpcId: string, password: string): void; getPassword(icpcId: string): string | null; list(): Array<{ icpcId: string }> }`——内部持 `JsonStore<Record<icpcId, string>>`，写入值一律 `secretbox.encrypt()`，读取时 decrypt。
- 用 `hono/jwt`（`sign`/`verify`）实现 token。

- [ ] **Step 1: 写失败测试**：token roundtrip；过期 token 返回 null（构造 ttl=-1）；篡改 payload 返回 null；`TeamStore.setPassword` 后**直接读磁盘 JSON 文件断言值不含明文密码**且 `getPassword` 还原正确。
- [ ] **Step 2: 确认 FAIL**
- [ ] **Step 3: 实现** 两个文件。
- [ ] **Step 4: 测试 PASS**
- [ ] **Step 5: Commit** `feat(server): team token + encrypted team password store`

### Task 6: OMS 识别策略链 + 指纹采集

**Files:**
- Create: `apps/server/src/oms/identify.ts`
- Create: `apps/server/src/oms/capture.ts`
- Test: `apps/server/src/oms/identify.test.ts`、`apps/server/src/oms/capture.test.ts`

**Interfaces:**
- Consumes: Task 2 `Config["oms"]`。
- Produces: `type ClientFingerprint = { ip: string; method: string; path: string; headers: Record<string, string> }`。
- Produces: `type IdentifyResult = { strategy: "client-id" | "ua-regex" | "custom-header"; matched: string } | null`。
- Produces: `identifyClient(fp: ClientFingerprint, cfg: Config["oms"], boundClientIds?: Set<string>): IdentifyResult`——顺序尝试：`client-id`（headers 里 `x-oms-client-id` 且在 boundClientIds 中）→ `ua-regex-list`（User-Agent 匹配任一正则）→ `custom-header`；全不中返回 null。默认 uaRegexes 含 `OMSClient` 与 `QtWebEngine/\\d`。
- Produces: `class FingerprintCapture { constructor(filePath: string); record(fp: ClientFingerprint): void; close(): void }`——JSONL 逐行追加；**记录前删除 `cookie` 与 `authorization` 头**（键名小写比较）。

- [ ] **Step 1: 写失败测试**：
  - UA `"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/108.0.0.0 Safari/537.36 QtWebEngine/6.5.3"` 命中 `ua-regex` 策略且 matched 为 `QtWebEngine/\d`；
  - UA 含 `OMSClient` 命中且策略优先级低于 client-id（两个都给时返回 client-id）；
  - 无绑定 clientId + 普通 Chrome UA（`Chrome/120.0.0.0`，无 QtWebEngine）返回 null；
  - customHeader 配置 `x-exam-hw: abc` 且请求携带时命中；
  - capture：record 三条后文件为 3 行 JSONL，且 headers 中无 `cookie`/`authorization` 键。
- [ ] **Step 2: 确认 FAIL**
- [ ] **Step 3: 实现** 两个文件。
- [ ] **Step 4: 测试 PASS**
- [ ] **Step 5: Commit** `feat(server): pluggable OMS client identification + fingerprint capture`

### Task 7: HTTP 骨架 + 静态托管

**Files:**
- Create: `apps/server/src/server.ts`
- Modify: `apps/server/src/index.ts`（改为装配并 `Bun.serve`）
- Test: `apps/server/src/server.test.ts`

**Interfaces:**
- Consumes: Task 2 `loadConfig`、Task 6 `identifyClient`/`FingerprintCapture`。
- Produces: `createApp(cfg: Config, deps?: Partial<Deps>): Hono`——`Deps = { dataDir: string }`。路由：`GET /health` → `{"ok":true}`；`ALL *` 中间件里若 `cfg.oms.capture === true` 则把 fingerprint 交给 `FingerprintCapture`；静态目录 `apps/server/static`（不存在则跳过挂载）。
- Produces: `src/index.ts` 读取 `data/settings.json`（缺则 `writeDefaultConfig`）、启动 `Bun.serve({ fetch: app.fetch, port })`。

- [ ] **Step 1: 写失败测试**（`app.request()`，不起真实端口）：`/health` 200 且 body `{"ok":true}`；capture=true 时请求 `/health` 后 dataDir 下 capture JSONL 多一行；capture=false 不产生文件。
- [ ] **Step 2: 确认 FAIL**
- [ ] **Step 3: 实现** server.ts 与 index.ts 装配。
- [ ] **Step 4: 全量 `bun run test` PASS**
- [ ] **Step 5: Commit** `feat(server): hono app skeleton with health, capture middleware, static hosting`

### Task 8: 认证任务队列 + SSE

**Files:**
- Create: `apps/server/src/queue/authQueue.ts`
- Create: `apps/server/src/sse/bus.ts`
- Modify: `apps/server/src/server.ts`（挂载队列与 SSE 路由）
- Test: `apps/server/src/queue/authQueue.test.ts`、`apps/server/src/sse/bus.test.ts`

**Interfaces:**
- Consumes: Task 6 `IdentifyResult`、Task 7 `createApp`。
- Produces: `type AuthTask = { id: string; examNum: string; clientId: string | null; strategy: string; status: "pending" | "approved" | "rejected" | "auto-done"; createdAt: string }`。
- Produces: `class AuthQueue { enqueue(t: Omit<AuthTask, "id" | "status" | "createdAt">): AuthTask; approve(id: string): AuthTask | null; reject(id: string): AuthTask | null; list(status?: AuthTask["status"]): AuthTask[]; autoAccept: boolean; onChange(cb: (t: AuthTask) => void): () => void }`——`enqueue` 时若 `autoAccept` 直接置 `auto-done`；同 examNum+clientId 已存在 pending 则去重返回原任务。持久化：内部 `JsonStore<AuthTask[]>`（Task 3）。
- Produces: `class SseBus { publish(channel: string, event: string, data: unknown): void; subscribe(channel: string, cb: (e: { event: string; data: unknown }) => void): () => void }`。
- Produces: 路由 `GET /admin/api/auth-tasks`（list）、`POST /admin/api/auth-tasks/:id/approve|reject`、`GET /admin/api/events`（SSE 流，channel `admin`）。

- [ ] **Step 1: 写失败测试**：autoAccept=false 时 enqueue 状态 pending、approve 后 approved；同 examNum+clientId 重复 enqueue 去重；autoAccept=true 直接 auto-done；SseBus subscribe 后 publish 收到事件，退订后不再收；server 层用 `app.request` 打 `/admin/api/auth-tasks` 得到列表 JSON。
- [ ] **Step 2: 确认 FAIL**
- [ ] **Step 3: 实现** 三个文件。
- [ ] **Step 4: `bun run test` 全量 PASS**
- [ ] **Step 5: Commit** `feat(server): auth task queue with auto-accept, dedup, SSE bus`

---

## 完成定义（Plan 1）

- `pnpm install && bun run test` 全绿；`bun run server` 启动后 `curl localhost:8080/cxtool/health`（注意 contextPath 挂载）返回 `{"ok":true}`，`data/settings.json` 首次启动自动生成。
- Plan 2（DOMjudge 集成）与 Plan 3（前端/打包）另行编写。
