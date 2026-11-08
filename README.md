# CUIT XCPC TOOL

一个用于简化代码打印和气球打印的XCPC工具，为CUIT的XCPC校赛开发。对接 DOMjudge，提供队伍认证、气球票据与代码打印（含 Chrome kiosk 自动打印）。

> [!NOTE]
> 外部榜单（xcpcio/board）功能已停止提供，`xcpcio/` 目录已从仓库移除。

> [!IMPORTANT]
> 本项目正在用 **TypeScript + Bun** 重写（见 [重构设计](docs/superpowers/specs/2026-11-07-ts-bun-rewrite-design.md)）。Java 版仍是当前可用的完整实现；新版已完成服务器核心，DOMjudge 集成与前端迁移见下方 [TypeScript 重写](#typescript-重写进行中)。

## 目录结构

| 目录 | 内容 |
|---|---|
| `src/` + `build.gradle` | Java 21 / Spring Boot 4 后端（当前生产版本） |
| `vue/` | 管理端前端（Vue 3 + Element Plus，vue-cli） |
| `apps/server/` | **新**：TypeScript/Bun 后端核心（重写中） |
| `apps/admin/` | **新**：管理端前端（Vue 3 + Element Plus + Vite，构建产物输出到 `apps/server/static/`） |
| `proxy/` | 独立的 DOMjudge 自动登录反代（Node） |
| `script/` | 运维产物：nginx 配置示例、`print.sh`、队伍/组织 JSON 生成脚本 |
| `docs/superpowers/` | 重写设计文档与实施计划 |

---

## Java 版使用（当前生产版本）

本程序使用 Java 21 开发，理论上 Windows, Linux, macOS 都能使用。

通过下面命令启动：

```bash
java -jar CUITXCPCTool-XXX.jar
```

第一次启动的时候会生成 `settings.properties` 和 `db-secret.properties` 文件。

- `db-secret.properties` 用于配置本地 `H2` 数据库密码

- `settings.properties` 中需要注意：
  - `settings.use-special-client` 如果设置为 `true`，通过请求 `User-Agent` 判断客户端（默认匹配 `OMSClient` 子串）。该判定只对 `OMSClient 1.X`（.NET/CefSharp 内核）有效；新版 Qt 客户端使用 QtWebEngine 默认 UA，不再包含 `OMSClient` 字样。
  - 开启后需要配合 `settings.nginx-verify-route-path` 使用，原理是：

```plaintext
校验通过——>返回token——>带token跳转——>nginx截获token——>请求验证token——>进入Domjudge
```

> [!NOTE]
> nginx 的配置在 `script` 下有示例。

- 为了确保稳定使用，推荐给 `Domjudge` 设置 `BaseURL`。
- `settings.unfreeze-board-time` 为赛后解榜时间，单位是小时
- `settings.should-forbidden-online-print` 是否禁用线上打印，如果禁止，需要给线上的队伍设置一个特别的座位号并写在 `settings.online-location-key`。
- `org.domjudge.print-token` 用于 `Domjudge` 发送打印任务时校验。

### 自动打印

自动打印需要配合 `Google Chrome` 使用，其它浏览器未测试。

> [!NOTE]
> Domjudge 使用的打印命令（脚本在 `script` 下有示例）：
>
> ```bash
> /opt/print_pdf.sh "[location]" "[teamname]" "[teamid]" "[file]" "[original]" 2>&1
> ```

> [!NOTE]
> 开启自动打印前，请打印测试页，确保打印机可以正常工作，并检查测试页内容和格式

1. 关闭所有浏览器窗口，在任务管理器中确认所有浏览器相关进程均已退出。
2. 备份原 Chrome/Edge 快捷方式，右键单击图标，依次选择 `属性` - `快捷方式`。
3. 在 `目标` 中原有内容后依次追加一个空格和 `--kiosk-printing`，下方是一个样例。

   ```textile
   "C:\Program Files\Google\Chrome\Application\chrome.exe" --kiosk-printing
   ```

4. 点击 `应用`，双击修改后的快捷方式，确认打印时不再显示预览对话框。

### 队伍导入

0.6.0-Preview 后，队伍信息会从 Domjudge 自动拉取，上传的 Excel 只需要提供无法从 Api 查询的队伍账号的密码。

| ICPC_ID   | PASSWORD     |
|-----------|--------------|
| {icpc_id} | {password}   |

为了使得选手和教练名字能正常获取，在 Domjudge 导入的队伍 Json 参考如下：

```json
{
  "id": "=icpc_id",
  "icpc_id": "example_id",
  "group_ids": [
    "participants"
  ],
  "name": "TeamName",
  "display_name": "TeamName",
  "organization_id": "organization_id",
  "members": "Players: Person1,Person2,Person3,.. Coaches: Person1,Person2,..",
  "location": {
    "description": "Team Location"
  }
}
```

### 构建

1. 构建前端 `vue`，构建后的文件会自动放入 `static`。

2. 构建 `jar`。

```bash
cd vue && npm install && npm run build
./gradlew clean build
```

---

## TypeScript 重写（进行中）

目标：单技术栈（TS 全栈）、Bun 直接运行部署（不打包 exe）、移除 nginx 与数据库，并根治"新版 OMS 客户端识别失效"问题。

- **设计文档**：[docs/superpowers/specs/2026-11-07-ts-bun-rewrite-design.md](docs/superpowers/specs/2026-11-07-ts-bun-rewrite-design.md)
- **实施计划**：[docs/superpowers/plans/](docs/superpowers/plans/)（Plan 1 服务器核心已完成，Plan 2 DOMjudge 集成与 Plan 3 前端/打包待做）

### 新版客户端识别方案（取代 UA 子串硬编码）

识别为可插拔策略链，按序尝试、配置启用：

1. `client-id`——OMS 客户端启动时向后端注册的持久 clientId（`x-oms-client-id` 头），最强信号；
2. `ua-regex-list`——可配置的 UA 正则数组，内置 `OMSClient`（1.X）与 `QtWebEngine/\d`（Qt 新版）两条预置规则；
3. `custom-header`——自定义请求头键值校验。

另带**指纹采集端点**（管理端开关，默认关）：开启期间把所有进站请求的方法/路径/headers 落盘为 JSONL（自动剔除 `cookie`/`authorization`），热身赛现场几分钟即可给新一代客户端补规则，无需改代码。

### 开发（apps/server）

```bash
bun install          # 在 apps/server 下
bun run test         # bun test，测试与源码同目录 *.test.ts
bun run server       # 启动，首启自动生成 data/settings.json 与 JWT 密钥
curl localhost:8080/cxtool/health   # => {"ok":true}
```

- 运行时 Bun 1.x，HTTP 框架 Hono，校验 zod；禁用需要原生编译的依赖（现场离线）。
- 无数据库：`data/` 下 JSON 文件存储，tmp+rename 原子写入；队伍密码字段经 AES-256-GCM 加密。
- 所有 API 路由挂在 `/cxtool` 上下文路径下。

### 现状与计划

| 阶段 | 内容 | 状态 |
|---|---|---|
| Plan 1 | monorepo 脚手架 + 配置/存储/加密/JWT/OMS 识别/认证队列/SSE | ✅ 完成 |
| Plan 2 | DOMjudge API 客户端、全量反向代理、打印回调、气球任务、榜单数据路由 | ⏳ 待开始 |
| Plan 3 | 管理端 Vue 重写（Vite）、部署脚本与 CI（不打包 exe，目标机安装 Bun） | ⏳ 待开始 |

> 外部榜单功能已停止提供：`xcpcio/` 已从仓库移除，TS 版不再包含榜单数据路由。

### 新版部署

新版使用 Bun 直接运行，无需打包：

```bash
cd apps/admin && bun install && bun run build   # 构建管理端到 apps/server/static
cd ../server && bun install
bun run src/index.ts                            # 或在仓库根目录 bun run server
```

完整部署步骤（Windows / Linux、settings.json 配置、systemd 单元示例）见 [script/deploy/deploy.md](script/deploy/deploy.md)。

## License

GPL-2.0（见 [LICENSE](LICENSE)）。
