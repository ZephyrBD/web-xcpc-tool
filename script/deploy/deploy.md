# 部署指南（TypeScript 版）

新版 CUIT XCPC TOOL 使用 **Bun** 直接运行，无需打包 exe，无需 nginx、数据库与 Java 环境。
单个进程同时提供：`/cxtool` 管理端（静态页面 + API）与 `/cxtool/dj/*` DOMjudge 反向代理。

> Java 旧版部署方式不变（`java -jar`），见 README「Java 版使用」。

## 前置条件

### 安装 Bun

Windows（PowerShell）：

```powershell
powershell -c "irm bun.sh/install.ps1 | iex"
```

Linux / macOS：

```bash
curl -fsSL https://bun.sh/install | bash
```

安装后重新打开终端，`bun --version` 确认可用（Bun 1.x）。

### 获取代码

```bash
git clone https://github.com/<org>/CUITXCPCTool.git
cd CUITXCPCTool
```

## 构建与启动

```bash
# 1. 构建管理端前端（产物输出到 apps/server/static，若目录已存在可跳过）
cd apps/admin
bun install
bun run build

# 2. 启动服务
cd ../server
bun install
bun run dev        # 等价于 bun run src/index.ts
```

也可在仓库根目录使用快捷命令：

```bash
bun install
bun run server
```

启动后：

- 服务监听 `http://<host>:8080`，所有路由挂在 `/cxtool` 下。
- 健康检查：`curl http://localhost:8080/cxtool/health` → `{"ok":true}`。
- 管理端登录页：`http://localhost:8080/cxtool/`。
- 首次启动自动生成 `apps/server/data/settings.json` 与 JWT 密钥。

## 配置（apps/server/data/settings.json）

首次启动生成的默认配置需要修改以下字段后重启：

| 字段 | 说明 |
|---|---|
| `port` | 监听端口，默认 `8080` |
| `contextPath` | 上下文路径，默认 `/cxtool`，一般不改 |
| `domjudge.baseUrl` | DOMjudge 站点地址，例如 `https://domjudge.example.com` |
| `domjudge.adminUser` / `domjudge.adminPassword` | DOMjudge 管理员账号，供代理与 API 拉取使用 |
| `domjudge.timeoutSeconds` | DOMjudge API 请求超时秒数，默认 `10`；官方 demo 等慢站点建议调大（如 `65`） |
| `admin.username` | 本服务管理端用户名，默认 `admin` |
| `admin.passwordHash` | 本服务管理端密码的 **bcrypt 哈希**（见下） |
| `print.token` | DOMjudge 打印回调校验 token |
| `balloon.contestId` | 气球服务监听的 DOMjudge 赛题 ID |

> 注意 `domjudge.baseUrl` 指向的是 **DOMjudge 本身**的地址；队伍/客户端访问本服务是通过 `http://<host>:<port>/cxtool`（OMS 客户端进站地址），两条链路不要混淆。

### 生成管理端 passwordHash

`admin.passwordHash` 是 bcrypt 哈希。任选一种方式生成：

```bash
cd apps/server
bun -e "import('bcryptjs').then(b=>console.log(b.hashSync('你的密码',10)))"
```

把输出的 `$2b$10$...` 字符串填入 `admin.passwordHash`，重启服务生效。

## Linux：systemd 常驻

`/etc/systemd/system/cuitxcpctool.service`：

```ini
[Unit]
Description=CUIT XCPC Tool (TS)
After=network.target

[Service]
Type=simple
User=xcpc
WorkingDirectory=/opt/CUITXCPCTool/apps/server
ExecStart=/home/xcpc/.bun/bin/bun run src/index.ts
Restart=on-failure
RestartSec=3

[Install]
WantedBy=multi-user.target
```

> `WorkingDirectory` 必须是 `apps/server`，运行时数据 `data/` 与静态资源 `static/` 均按相对路径解析。
> `ExecStart` 中 bun 路径按实际安装位置调整（`which bun`）。

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now cuitxcpctool
systemctl status cuitxcpctool
```

## Windows：常驻

两种任选：

- **NSSM**：`nssm install cuitxcpctool "C:\Users\<you>\.bun\bin\bun.exe" "run src/index.ts"`，并把 AppDirectory 设为 `<仓库>\apps\server`。
- **计划任务**：开机触发运行 `start.ps1`（见下）。

## 启动脚本（可选）

仓库提供 `script/deploy/start.sh`（Linux/macOS）与 `script/deploy/start.ps1`（Windows）：
自动安装依赖、在缺失时构建管理端、然后前台启动服务。

```bash
bash script/deploy/start.sh          # Linux/macOS
powershell -File script/deploy/start.ps1   # Windows
```

## 现场核对清单

1. `curl http://localhost:8080/cxtool/health` 返回 `{"ok":true}`。
2. 浏览器打开 `http://<host>:8080/cxtool/`，用 `admin.username` + 明文密码登录成功。
3. DOMjudge 管理端里把队伍进站/外链 BaseURL 指向 `http://<host>:<port>/cxtool`（代理路径为 `/cxtool/dj/...`）。
4. 给队伍分配队伍码（管理端导入队伍密码后，通过 TeamStore `setTeamCode`），把队伍码投屏给各队；用一台队伍机器在 `/cxtool/dj/verify` 输入队伍码完成登录 + 打印。如需限制登录时段，配置 `teamLogin.start` / `teamLogin.end`（ISO 时间，留空不限）。

## 安全说明

管理端登录 Cookie 未设置 `Secure` 标志：现场部署走的是受信任局域网内的纯 HTTP，浏览器若要求 Secure Cookie 将无法在 HTTP 下送达。若需要把服务暴露到局域网之外，请在前面加一层带 TLS 的反向代理（如 nginx + 证书）。
