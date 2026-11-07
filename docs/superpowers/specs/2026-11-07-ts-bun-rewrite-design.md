# CUITXCPCTool 重构设计（TypeScript + Bun）

日期：2026-11-07
状态：待用户批准
前身：Java 21 / Spring Boot 4 版本（本仓库现有实现），功能全部保留、行为兼容为非目标（允许重新设计交互）。

## 1. 意图与动机

现有 CUITXCPCTool 是为 CUIT 校赛构建的 XCPC 现场工具：对接 DOMjudge，提供队伍认证、气球票据、代码打印（含 Chrome kiosk 自动打印）、榜单展示。技术栈分裂：Java 后端 + Vue3 管理端 + vendored XCPCIO 榜单 + 独立 Node 代理 + nginx 验证层。

动机：**统一技术栈到 TypeScript/Node**，消除 Java、减少部署组件（nginx、JVM），并为"高版本 OMS 客户端识别失效"提供根治方案。

## 2. 已确定的决策（用户拍板）

| 决策点 | 结论 |
|---|---|
| 语言/技术栈 | TypeScript 全栈统一 |
| 运行时 | **Bun**（`bun build --compile` 出免安装单文件 exe，Windows/Linux/macOS） |
| 进程模型 | **单进程全包**：HTTP API + 托管两个前端静态资源 + 反向代理 DOMjudge + SSE，部署即单可执行文件 |
| 数据库 | **不引入数据库**。比赛为单日生命周期、数据量几百条；用轻量 JSON 文件存储 + 原子写入（保留升级到 `bun:sqlite` 的余地） |
| nginx | **从部署中移除**。Node 后端自己作为 DOMjudge 反向代理，验证 token 后转发 |
| 前端 | `vue/`（管理端，Element Plus）功能保留，允许从 vue-cli 迁移到 Vite。**外部榜单（xcpcio/board）功能停止提供**（2026-11-07 用户决定），`xcpcio/` 目录在 Plan 3 从仓库移除 |
| 仓库结构 | pnpm monorepo（apps/server、apps/admin、apps/board、packages/shared 等） |

## 3. OMS 客户端识别（本次重构的核心改进）

背景与证据见 `work/20261107-190153-omsclient-fingerprint-analysis-f/notes/findings.md`。要点：

- 旧方案：UA 包含 `OMSClient` 子串 → 发 JWT。仅对 1.X（.NET/CefSharp）客户端有效。
- 新版（Qt6.5.3/QtWebEngine/Chromium 108）UA 为默认值，不含 `OMSClient`；但含 `QtWebEngine/6.5.3` 尾缀指纹。
- 新版客户端启动即向 OMS 后端注册并持有持久 **clientId**（UUID）；旧工具的 examNum↔clientId 绑定协议在 Qt 版中依然存在。

设计：

1. **可插拔识别策略链**（按顺序尝试，配置启用）：
   - `client-id`：请求携带的 clientId（配合考试号绑定），最强信号，首选；
   - `ua-regex-list`：可配置的 UA 正则数组（内置 `OMSClient`、`QtWebEngine/\d` 两条预置规则）；
   - `custom-header`：可配置的请求头键值校验。
2. **指纹采集端点**（管理端开关控制，默认关）：命中开关期间，把所有进站请求的 method/path/headers 全量落盘（JSONL）。热身赛现场几分钟即可给新一代客户端补规则，无需改代码。
3. 识别通过后签发 JWT，行为与现版本一致（跳转 → 代理验证 → 进 DOMjudge），但 JWT 签发与验证全部收敛在本进程内（nginx 层已移除）。

## 4. 架构

**入口 URL 语义（已确认）**：OMS 客户端内嵌浏览器访问的入口 URL 每场比赛由工作人员配置/下发，客户端侧没有写死的路由或参数。因此新服务可自由定义入口路径，唯一的外部硬契约是 DOMjudge 打印回调的 `org.domjudge.print-token`。

**OMS 凭据加密（已确认）**：队伍数据中仅 `icpc_id → password` 字段加密存储（密钥为首次启动生成、存于本地密钥文件的随机值，等价于现 `db-secret.properties` 的角色），其余数据明文 JSON。

```
pnpm monorepo
├── apps/
│   ├── server/        # Bun + HTTP 框架，全部后端逻辑
│   ├── admin/         # 管理端（Vue3 + Element Plus，迁 Vite）
│   └── board/         # vendored xcpcio fork（保留 pnpm workspace，构建产物出 static/board）
└── packages/
    └── shared/        # API 类型定义（前后端共享 zod/类型）
└── script/            # 部署脚本、print.sh 等运维产物（保留）
```

- **apps/server 内部分层**：`routes`（HTTP 路由）→ `services`（认证/气球/打印/榜单转换）→ `store`（JSON 持久化）→ `domjudge`（上游 API 客户端与反向代理）→ `oms`（客户端识别策略链）。
- **反向代理**：`/dj/*` 流量经验证后转发到 DOMjudge BaseURL；打印回调（`org.domjudge.print-token`）在代理层截获。SSE 事件推送保留（认证任务、气球任务队列实时性）。
- **存储**：`data/` 目录下若干 JSON 文件（teams、auth-tasks、balloon-tasks、settings、team-clients），写入用 tmp+rename 原子替换；进程内单例内存态，启动时加载。
- **自动打印**：保留现有 Chrome `--kiosk-printing` 方案与 DOMjudge `print_pdf.sh` 对接；PDF 渲染用 OpenPDF 的替代（如 pdf-lib 或直接透传 PDF 字节流），行为对打印机透明。

## 5. 目标 / 非目标 / 反目标

- **目标**：功能等价（认证、气球、打印、榜单、SSE、Excel 导入、DOMjudge 拉取）；单 exe 部署；高版本 OMS 可识别；TS 全栈类型共享。
- **非目标**：多机集群、持久化多年数据、重写 xcpcio 榜单本身、做通用监考系统。
- **反目标**：为了"统一"而引入重数据库或微服务拆分；破坏现场"拷贝即跑"的部署体验。

## 6. 约束

- Java 版数据无需迁移（比赛即弃数据）；`settings.properties`/`db-secret.properties` 的配置项语义需在新配置（TOML/JSON，用户可选）中延续并做启动迁移提示。
- 现场网络隔离：不得依赖外网（依赖全部进构建产物或 vendor）。
- 兼容 DOMjudge 的 BaseURL 拼接语义（README 已记录的 URL 规则）。

## 7. 留给构建者的决策

- HTTP 框架：Hono（推荐，轻、Bun 原生适配好）或 Elysia（类型更强、生态较新）——构建者定，二选一。
- 配置文件具体格式与热加载策略。
- JSON store 的锁与并发写入细节（单进程内基本无竞争，做好 tmp+rename 即可）。
- 管理端 Vite 迁移的脚手架细节。
- 日志方案（结构化 JSON 日志推荐，保留现有 `[HH:mm:ss]` 可读格式的兼容选项）。

## 8. 设计者拍板记录（builder check 后补充）

- **反代范围**：全量代理 `/dj/*` 到 DOMjudge（静态资源、cookie、提交上传都过代理）；DOMjudge 的 `BaseURL` 配置为本服务地址，消除重定向/绝对路径问题。token 验证收敛在代理层。
- **榜单数据路由**：外部榜单功能已停止提供（2026-11-07 用户决定），不再实现 board 数据端点。
- **认证生命周期沿用现有语义**：无论哪种识别策略命中，都走"认证任务队列 → 管理端审批（含自动通过开关）→ SSE 推送"的既有流程；clientId↔examNum 绑定照旧落 `team-clients` 存储。
- **管理端前后端彻底重设计**：现有 Vue 代码不要求原样运行，前后端用 `packages/shared` 的共享类型（zod schema）定义新契约。
- **生产环境（已确认）**：现场服务器为 **Windows**，Chrome `--kiosk-printing` 在同机运行，DOMjudge 在同一内网（Linux 主机）。构建目标以 `windows-x64` 为主，Linux/macOS 为次要产物。
