# Web XCPC Tool

一个用于简化代码打印和气球打印的 XCPC 工具，为 CUIT 的 XCPC 校赛开发。对接 DOMjudge，提供队伍认证（team-code 登录）、DOMjudge 反向代理、代码打印（含 Chrome kiosk 自动打印）、气球票据与管理端控制台。

当前实现为 **TypeScript + Bun 单进程版本**（设计文档见 [docs/superpowers/specs/2026-11-07-ts-bun-rewrite-design.md](docs/superpowers/specs/2026-11-07-ts-bun-rewrite-design.md)）。

> [!NOTE]
> 项目的早期实现已移至 `legacy/java` 分支（完整保留，可通过 `git show legacy/java:src/main/java` 查看）。主分支不再包含早期代码。

> [!NOTE]
> 外部榜单（xcpcio/board）功能已停止提供，TS 版不包含榜单数据路由。

功能要点：

- 队伍认证：队伍码登录，登录时段（`teamLogin.start/end`）外队伍码登录走管理员审批（认证管理 → 登录审批，当次有效）。

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
