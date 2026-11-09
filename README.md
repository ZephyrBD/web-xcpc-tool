# Web XCPC Tool

一个用于简化代码打印和气球打印的 XCPC 工具，为 CUIT 的 XCPC 校赛开发。对接 DOMjudge，提供队伍认证（team-code 登录）、DOMjudge 反向代理、代码打印（含 Chrome kiosk 自动打印）、气球票据与管理端控制台。

当前实现为 **TypeScript + Bun 单进程版本**（设计文档见 [docs/superpowers/specs/2026-11-07-ts-bun-rewrite-design.md](docs/superpowers/specs/2026-11-07-ts-bun-rewrite-design.md)）。

> [!NOTE]
> 项目的早期实现已移至 `legacy/java` 分支（完整保留，可通过 `git show legacy/java:src/main/java` 查看）。主分支不再包含早期代码。

> [!NOTE]
> 外部榜单（xcpcio/board）功能已停止提供，TS 版不包含榜单数据路由。

功能要点：

- 队伍认证：队伍码登录，登录时段（`teamLogin.start/end`）外队伍码登录走管理员审批（认证管理 → 登录审批，当次有效）。
- 比赛设置：管理端「设置 → 比赛设置」一张卡片管比赛 ID、气球轮询间隔与登录时段；**比赛 ID 写一次即锁定**，换比赛只能「清空数据」（见下）。
- 气球：任务只来自 DOMjudge 的 `GET /api/v4/contests/{id}/balloons`，`done` 为唯一权威；消失的气球标记「已隐藏」而不是已派送。
- 运行时配置热生效：除端口、访问前缀、JWT 密钥需重启外，保存后立即生效。
- 结构化日志：终端彩色、文件纯文本，单个 `data/logs/latest.log`（启动截断），文件里管理端密码脱敏为 `********`。

## 目录结构

| 目录 | 内容 |
|---|---|
| `apps/server/` | TypeScript/Bun 后端（Hono + zod，无数据库，`data/` 下 JSON 存储） |
| `apps/admin/` | 管理端前端（Vue 3 + Element Plus + Vite，构建产物输出到 `apps/server/static/`） |
| `proxy/` | 独立的 DOMjudge 自动登录反代（Node） |
| `script/` | 运维产物：nginx 配置示例、`print.sh`、队伍/组织 JSON 生成脚本、部署文档 |
| `docs/` | 设计文档与实施计划 |

## 开发

每个 app 独立安装依赖并运行（Bun 1.x）：

```bash
# 后端
cd apps/server && bun install
bun test            # 测试，测试与源码同目录 *.test.ts
bun run server      # 启动，首启自动生成 data/settings.json 与 JWT 密钥
curl localhost:8080/wxt/health   # => {"ok":true}

# 管理端
cd apps/admin && bun install
bun test            # bun test（happy-dom）
bun run typecheck   # vue-tsc --noEmit
bun run build       # 构建到 apps/server/static/
```

- HTTP 框架 Hono，校验 zod；禁用需要原生编译的依赖（现场离线）。
- 无数据库：`data/` 下 JSON 文件存储，tmp+rename 原子写入；队伍密码字段经 AES-256-GCM 加密。
- 所有 API 路由与页面挂在 `/wxt` 上下文路径下。
- 运行时数据目录 = 进程当前工作目录下的 `data/`（`bun run dev` 在 `apps/server` 下即 `apps/server/data/`）。
- 管理端构建产物输出到 `apps/server/static/`，由服务端直接托管；根目录的 Gradle 工程与本 TS 版本无关，跑 TS 版不需要它。

## 比赛设置、气球与日志

### 比赛 ID 锁定与「清空数据」

「设置 → 比赛设置」集中维护比赛 ID、气球轮询间隔与队伍登录时段。

- 比赛 ID 保存后即锁定：气球任务、打印留档、队伍同步都按这个 ID 归属，静默换成另一场比赛会把两边数据混在一起。再次保存同一个值（表单每次都会带上）是允许的，保存**不同**的值会被服务端拒绝（HTTP 403：`比赛 ID 已锁定，设置后不可修改；如需更换请先清空比赛数据`）。
- 唯一解锁方式 = 清空数据：「清空数据」按钮（需输入确认词「清空」，接口 `POST /admin/api/data/purge`）会删除队伍、队伍账号密码、队伍码、登录历史、登录审批记录、打印任务、`data/printed/` 与 `data/pdf/` 下的留档源码/PDF、气球任务，并把比赛 ID 置空；**保留** `settings.json` 的其余设置与 `data/secret.key`。清空后填新的比赛 ID 保存，气球轮询立即自动开始。

### 气球任务的数据来源

- 只有一个来源：`GET /api/v4/contests/{id}/balloons`。不再拉取 judgements/submissions 自行合成气球。
- 「已派送」完全由该接口的 `done` 字段双向同步（DOMjudge 撤销 `done`，本地也会退回待派送）。
- 某轮轮询里消失的气球**不会**被标成已派送，而是保留上次状态并标「已隐藏」（stale）：封榜期间 DOMjudge 会隐藏气球，重测也可能让气球消失，把「看不见」当成「已送出」会让志愿者去追已派出的气球。隐藏中的待派送气球退出派送队列，DOMjudge 重新列出后自动恢复。
- 「标记已派送」只接受最近一轮轮询里出现过的气球 id，其它 id 返回 404 `balloon not found`。
- **从旧数据目录升级**：旧版本的气球任务由判题结果合成，id 是提交 id、没有 `balloonId` 字段，永远匹配不上 DOMjudge 的 `balloonid`。服务启动时会一次性丢弃这些旧行——无论它们属于哪场比赛（包括与当前比赛 ID 相同的旧行）——并打一行 `已丢弃 N 条旧版气球任务` 的信息日志；当前格式的行（带 `balloonId` 字段，可能是 `null`）原样保留。所以升级后旧历史不会以「已隐藏」的形式堆积，也不用手工删 `data/balloon-tasks.json`。若希望从空白开始，仍可先「清空数据」或停机删除该文件。

### 哪些设置要重启

保存后立即生效：DOMjudge 整段（地址 / 账号 / 超时）、打印令牌、管理端账号密码、登录时段、气球比赛 ID 与轮询间隔。

需要重启并重新登录的只有三项（启动时绑定，无法热改）：`port`、`contextPath`、`jwt.secret`（换密钥会让现有管理端与队伍 Cookie 立即失效）。

### 日志

- 位置：`data/logs/latest.log`（与 `settings.json` 同级），只有这一个文件，**每次启动清空**；需要留档请自行复制。
- 格式：`{日} {时:分:秒} {模块名右对齐 9 格} [{级别}] {消息}`，级别 `D/I/W/E/C`，多行消息续行缩进对齐。
- 颜色：仅终端输出带 ANSI 16 色，日志文件是纯文本（`NO_COLOR=1` 可关终端颜色）。
- 脱敏：管理端密码在日志文件里写成 `********`，只有启动横幅的终端输出显示明文（首次部署拿密码的地方）。

### 反向代理（nginx 等）

管理端 `/admin/api/*` 的所有写操作都会做同源校验（比对 `Origin`/`Referer` 的 scheme + host）。nginx 终止 TLS 时必须同时转发 `Host` 与 `X-Forwarded-Proto`，否则保存操作会 403 `cross-origin forbidden`：

```nginx
proxy_set_header Host              $http_host;
proxy_set_header X-Real-IP         $remote_addr;
proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
proxy_set_header X-Forwarded-Proto $scheme;
proxy_set_header X-Forwarded-Host  $http_host;
```

详见 [script/deploy/deploy.md](script/deploy/deploy.md)。

## 部署

新版使用 Bun 直接运行，无需打包：

```bash
cd apps/admin && bun install && bun run build   # 构建管理端到 apps/server/static
cd ../server && bun install
bun run src/index.ts                            # 或在仓库根目录 bun run server
```

完整部署步骤（Windows / Linux、settings.json 配置、systemd 单元示例）见 [script/deploy/deploy.md](script/deploy/deploy.md)。

## 打包发布

推送到 `v*` 格式的 tag（如 `v1.0.0`）会触发 [release 工作流](.github/workflows/release.yml)：自动构建管理端前端、用 `bun build --compile` 交叉编译出 windows-x64 / linux-x64 / linux-arm64 / macos-x64 四个单文件可执行程序，连同 `static/`（管理端前端）、`DEPLOY.md`、`LICENSE` 打成 zip，并创建 GitHub Release（变更日志取自上一个 tag 到当前 tag 的 git log）。

每个 zip 解压后在包根目录直接运行 `web-xcpc-tool`（Windows 为 `web-xcpc-tool.exe`，Linux/macOS 先 `chmod +x`）即可。静态目录解析顺序：

1. 环境变量 `WXT_STATIC_DIR`
2. 可执行文件旁的 `../static`
3. 当前目录 `./static`（zip 包内即此布局）

本地编译示例（版本号注入为 `dev-local`）：

```bash
cd apps/server
bun run compile   # 输出 dist/web-xcpc-tool(.exe)，配合 apps/server/static 运行
```

## DOMjudge 集成前提

- DOMjudge 需启用 `xheaders` 认证方式（`etc/restapi.secret` 对应的 `xheaders` 凭据供服务端调用 REST API）。
- 队伍进站认证走 team-code 登录，由本工具代理到 DOMjudge（含反向代理自动登录）。
- DOMjudge 打印命令示例（调用本工具的打印回调，脚本 `script/print.sh`）：

  ```bash
  curl -s -X POST http://<host>:8080/wxt/dj/print \
    -H "org.domjudge.print-token: <token>" \
    -F "file=@[file]" -F "original=[original]"
  ```

- 打印回调 `POST /wxt/dj/print` 接收 multipart 表单（`file` + `original`），并要求请求头 `org.domjudge.print-token` 与 `data/settings.json` 中配置的 token 一致；代码转 PDF 由服务端完成（参考 `script/print.sh`）。

## CI

GitHub Actions（`.github/workflows/ci.yml`）在 push/PR 到 main 时分别跑 `apps/server`（bun test + tsc）与 `apps/admin`（bun test + vue-tsc + build），并上传 `apps/server/static/` 构建产物。

## License

GPL-2.0（见 [LICENSE](LICENSE)），对本仓库全部代码生效；早期实现同样保留在 `legacy/java` 分支。
