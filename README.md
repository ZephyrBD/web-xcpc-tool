# Web XCPC Tool

[![CI](https://github.com/ZephyrBD/web-xcpc-tool/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/ZephyrBD/web-xcpc-tool/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/ZephyrBD/web-xcpc-tool)](https://github.com/ZephyrBD/web-xcpc-tool/releases)
[![License: GPL-2.0](https://img.shields.io/badge/license-GPL--2.0-blue.svg)](LICENSE)
[![Bun](https://img.shields.io/badge/bun-1.x-f472b6.svg)](https://bun.sh)

<!-- CI 与 Release 徽章在仓库转为 public 后才能正常渲染；私有仓库下会显示 not found。License 与 Bun 为静态徽章，始终可用。 -->

一个用于简化代码打印和气球打印的 XCPC 工具，为 CUIT 的 XCPC 校赛开发。对接 DOMjudge，提供队伍认证（team-code 登录）、DOMjudge 反向代理、代码打印（含 Chrome kiosk 自动打印）、气球票据与管理端控制台。

当前实现为 **TypeScript + Bun 单进程版本**（设计文档见 [docs/superpowers/specs/2026-11-07-ts-bun-rewrite-design.md](docs/superpowers/specs/2026-11-07-ts-bun-rewrite-design.md)）。

功能要点：

- 队伍认证：队伍码登录，登录时段（`teamLogin.start/end`）外队伍码登录走管理员审批（认证管理 → 登录审批，当次有效）。
- 比赛设置：管理端「设置 → 比赛设置」一张卡片管比赛 ID、气球轮询间隔与登录时段；**比赛 ID 写一次即锁定**，换比赛只能「清空数据」。
- 气球：任务只来自 DOMjudge 的 `GET /api/v4/contests/{id}/balloons`，`done` 为唯一权威；消失的气球标记「已隐藏」而不是已派送。
- 运行时配置热生效：除端口与 JWT 密钥需重启外，保存后立即生效。
- 结构化日志：单个 `data/logs/latest.log`（启动截断），文件里管理端密码脱敏为 `********`。

## 快速开始

```bash
git clone https://github.com/ZephyrBD/web-xcpc-tool.git
cd web-xcpc-tool/apps/admin && bun install && bun run build   # 管理端构建到 apps/server/static
cd ../server && bun install && bun run dev                                     # 启动，首启自动生成 data/settings.json 与 JWT 密钥
```

打开 http://localhost:8080/wxt/admin ，管理端密码在启动横幅里（终端明文）。详细配置与常驻部署见 [script/deploy/deploy.md](script/deploy/deploy.md)。

## 目录结构

| 目录 | 内容 |
|---|---|
| `apps/server/` | TypeScript/Bun 后端（Hono + zod，无数据库，`data/` 下 JSON 存储） |
| `apps/admin/` | 管理端前端（Vue 3 + Element Plus + Vite，构建产物输出到 `apps/server/static/`） |
| `script/` | 运维产物：`print.sh`、队伍/组织 JSON 生成脚本、部署文档 |
| `docs/` | 设计文档与实施计划 |

## 开发

每个 app 独立安装依赖并运行（Bun 1.x）：

```bash
# 后端
cd apps/server && bun install
bun test            # 测试，测试与源码同目录 *.test.ts
bun run dev         # 启动（或仓库根目录 bun run server），首启自动生成 data/settings.json 与 JWT 密钥
curl localhost:8080/wxt/health   # => {"ok":true}

# 管理端
cd apps/admin && bun install
bun test            # bun test（happy-dom）
bun run typecheck   # vue-tsc --noEmit
bun run build       # 构建到 apps/server/static/
```

- HTTP 框架 Hono，校验 zod；禁用需要原生编译的依赖（现场离线）。
- 无数据库：`data/` 下 JSON 文件存储，tmp+rename 原子写入；队伍密码字段经 AES-256-GCM 加密。
- 所有 API 路由与页面挂在 `/wxt` 上下文路径下（固定不可配置）。
- 运行时数据目录 = 进程当前工作目录下的 `data/`（在 `apps/server` 下启动即 `apps/server/data/`）。

## 部署

完整部署步骤（Windows / Linux、settings.json 配置、systemd 单元示例、日志与脱敏、气球与「清空数据」细节）见 [script/deploy/deploy.md](script/deploy/deploy.md)。

保存后立即生效的设置：DOMjudge 整段（地址 / 账号 / 超时）、打印令牌、管理端账号密码、登录时段、气球比赛 ID 与轮询间隔。需要重启并重新登录的只有两项：`port` 与 `jwt.secret`（换密钥会让现有管理端与队伍 Cookie 立即失效）。

保存后立即生效的设置：DOMjudge 整段（地址 / 账号 / 超时）、打印令牌、管理端账号密码、登录时段、气球比赛 ID 与轮询间隔。需要重启并重新登录的只有两项：`port` 与 `jwt.secret`（换密钥会让现有管理端与队伍 Cookie 立即失效）。

## DOMjudge 集成前提

- 自建 DOMjudge 启用 `xheaders` 认证方式（`auth_methods` 包含 `xheaders`）时，队伍访问 `/login` 会自动注入 `X-DOMjudge-Login` / `X-DOMjudge-Pass` 实现免密登录，开箱即用；未启用时注入的头会被 DOMjudge 忽略，队伍看到的是 DOMjudge 自己的登录页（工具的其余功能不受影响）。
- 服务端调用 DOMjudge REST API 使用 `etc/restapi.secret` 对应的管理员凭据（填入 `data/settings.json` 的 `domjudge` 段）。
- 打印回调 `POST /wxt/print` 接收 multipart 表单（`file` + `original`），并要求请求头 `org.domjudge.print-token` 与 `data/settings.json` 中配置的 token 一致；代码转 PDF 由服务端完成。DOMjudge 打印命令示例（脚本 `script/print.sh`）：

  ```bash
  curl -s -X POST http://<host>:8080/wxt/print \
    -H "org.domjudge.print-token: <token>" \
    -F "file=@[file]" -F "original=[original]"
  ```

- 管理端 `/admin/api/*` 的写操作有同源校验：nginx 终止 TLS 时必须同时转发 `Host` 与 `X-Forwarded-Proto`，否则保存操作会 403（nginx 示例见 deploy.md）。

## License

GPL-2.0（见 [LICENSE](LICENSE)），对本仓库全部代码生效。
