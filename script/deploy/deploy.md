# 部署指南

CUIT XCPC TOOL 使用 **Bun** 直接运行，无需打包 exe，无需 nginx、数据库。
单个进程同时提供：`/wxt` 管理端（静态页面 + API）与 `/wxt/dj/*` DOMjudge 反向代理。

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

也可在仓库根目录使用快捷命令（内部 `--cwd apps/server`，工作目录与上面一致）：

```bash
bun install
bun run server
```

两种方式的工作目录都是 `apps/server`，运行时数据统一落在 `apps/server/data/`（`settings.json`、各 JSON 存储与密钥同处一个目录；旧版本遗留的 `data/data/` 会在启动时自动上移一级）。

启动后：

- 服务监听 `http://<host>:8080`，所有路由挂在 `/wxt` 下。
- 健康检查：`curl http://localhost:8080/wxt/health` → `{"ok":true}`。
- 管理端登录页：`http://localhost:8080/wxt/`。
- 首次启动自动生成 `apps/server/data/settings.json`、JWT 密钥与管理端密码；**密码会以明文打印在启动横幅里**（见下）。

## 配置（apps/server/data/settings.json）

首次启动生成的默认配置需要修改以下字段（`admin` 段由服务自动维护，改密码请用管理台「设置」页）：

| 字段 | 说明 |
|---|---|
| `port` | 监听端口，默认 `8080` |
| `contextPath` | 上下文路径，默认 `/wxt`，一般不改 |
| `domjudge.baseUrl` | DOMjudge 站点地址，例如 `https://domjudge.example.com` |
| `domjudge.adminUser` / `domjudge.adminPassword` | DOMjudge 管理员账号，供代理与 API 拉取使用 |
| `domjudge.timeoutSeconds` | DOMjudge API 请求超时秒数，默认 `10`；官方 demo 等慢站点建议调大（如 `65`） |
| `admin.username` | 本服务管理端用户名，默认 `admin` |
| `admin.password` | 管理端密码明文，仅供启动横幅显示；**不要手改**，在管理台「设置」页改密码（见下） |
| `print.token` | DOMjudge 打印回调校验 token |
| `balloon.contestId` | 气球服务监听的 DOMjudge 比赛 ID；**写一次即锁定**，见下文「比赛设置与气球」 |

### 哪些设置要重启，哪些立即生效

管理台「设置」页保存后是**热生效**的：服务端只读内存中的运行时配置，每次请求都取最新值，所以下列改动**不用重启**：

- `domjudge` 整段（Base URL、管理员账号、超时秒数）与打印回调令牌；
- `admin.username` / `admin.password`（轮换密码后旧登录会话仍然有效，直到 Cookie 过期）；
- `teamLogin.start` / `teamLogin.end`（登录时段，立即影响 `/dj/verify`）；
- `balloon.contestId` / `balloon.pollIntervalSeconds`（气球轮询按新值重新排期）。

**需要重启服务**的只有三项，原因是它们在进程启动时就绑死了（端口由 `Bun.serve` 绑定、访问前缀是启动时挂载的路由前缀、JWT 密钥在启动时用于签发令牌）：

| 字段 | 不重启的后果 |
|---|---|
| `port` | 进程仍监听旧端口，新端口不生效 |
| `contextPath` | 路由仍挂在旧前缀下 |
| `jwt.secret` | 新密钥签发、旧密钥校验混用，现有管理端与队伍 Cookie 立即失效，需重新登录 |

修改这三项后重启服务并重新登录。

> 注意 `domjudge.baseUrl` 指向的是 **DOMjudge 本身**的地址；队伍/客户端访问本服务是通过 `http://<host>:<port>/wxt`（OMS 客户端进站地址），两条链路不要混淆。

### DOMjudge 免密登录（X-Headers）前置条件

本工具会在队伍访问 DOMjudge 的 `/login` 时自动注入 `X-DOMjudge-Login`（用户名）与 `X-DOMjudge-Pass`（base64 密码）请求头实现免密登录。前提：DOMjudge 配置项 `auth_methods` 必须包含 `xheaders`（`etc/domserver-config.php` 或 `dbpasswords.secret` 所在配置，改后重启 domserver），否则注入的头会被忽略，考生看到的是普通登录页。该注入匹配 `/login` 的最终路径段，因此 `domjudge.baseUrl` 带路径前缀（如 `https://demo.example.com/demoweb`，登录页为 `/demoweb/login`）时同样生效。


### 管理端密码

首次启动会自动生成一个随机管理端密码，并在启动横幅中打印，例如：

```
09 14:03:07   startup [I] Web XCPC Tool <version>
                          服务    http://localhost:8080/wxt
                          管理台  http://localhost:8080/wxt/admin   用户名: admin
                          密码    NE5vetKj8kJmhr6V
                          DOMjudge https://domjudge.example.com
                          气球    未启用（未配置赛题 ID）
```

密码同时以明文保存在 `data/settings.json` 的 `admin.password` 字段（对应的 `admin.passwordHash` 为 bcrypt 哈希）。**无需手工生成或填写哈希**。

如需换成固定密码：登录管理端后到「设置」页修改，保存时同时更新 `admin.passwordHash` 与明文 `admin.password`，**立即生效**（无需重启）。全程不要直接编辑 `settings.json`。

## 运行日志

- 位置：`<工作目录>/data/logs/latest.log`，即与 `settings.json` 同级的 `data/logs/` 下（`apps/server/data/logs/latest.log`）。只保留这一个文件，**每次启动都会清空**；需要留档请自行定期复制。
- 格式：每行 `{日} {时:分:秒} {模块名右对齐 9 格} [{级别}] {消息}`，级别为 `D`（debug）/ `I`（info）/ `W`（warn）/ `E`（error）/ `C`（critical）。多行消息（如堆栈）的续行会缩进到消息起始列，便于对齐阅读。

  ```
  09 14:03:07   startup [I] Web XCPC Tool <version>
  09 14:03:44   balloon [E] poll failed for contest 3: DOMjudge API error: ... (status 0)
  ```

- 颜色：只有**终端输出**带 ANSI 16 色（时间戳灰色、`I` 青色、`W` 黄色、`E` 红色、`C` 加粗亮红）；日志文件永远是纯文本。设置 `NO_COLOR=1` 可关闭终端颜色，`FORCE_COLOR=1` 可强制开启（写进 systemd 的日志收集时建议关掉）。
- 脱敏：管理端密码（含启动横幅里那一行）在日志文件中写成 `********`，**只有终端横幅显示明文**；这是首次部署时拿到密码的唯一入口。修改管理端密码（保存设置、清空数据）后新密码立即加入脱敏列表。长度不足 6 个字符的密码不参与脱敏。

## 比赛设置与气球

管理台「设置 → 比赛设置」一张卡片集中管理三件事：比赛 ID、气球轮询间隔、队伍登录时段。

- **比赛 ID 写一次即锁定**：保存后该 ID 只读，再次保存同一个值（表单每次都会带上）始终允许；保存一个**不同**的 ID 会被服务端拒绝（HTTP 403，`比赛 ID 已锁定，设置后不可修改；如需更换请先清空比赛数据`）。原因：气球任务、打印留档、队伍同步都按比赛 ID 归属，静默切比赛会把两场比赛的数据混在一起。
- **唯一解锁方式＝清空数据**：「设置 → 比赛设置」里输入确认词「清空」后点「清空数据」（`POST /admin/api/data/purge`），会删除并返回各条数：
  队伍列表、队伍账号密码、队伍码、登录历史、登录审批记录、打印任务、`printed/` 与 `pdf/` 下的留档源码/PDF、气球任务，并把 `balloon.contestId` 置空。
  **保留**：`settings.json` 里的其余设置（DOMjudge、打印令牌、轮询间隔、登录时段、管理端账号密码）与 `data/secret.key`。清空后填入新的比赛 ID 并保存，气球轮询会立即自动开始。
- **气球数据来源**：气球任务**只来自** `GET /api/v4/contests/{id}/balloons`，不再拉取 judgements/submissions 自行合成。 DOMjudge 是唯一权威：每条任务的「已派送」完全由该接口的 `done` 字段双向同步。
- **「已隐藏」（stale）语义**：某次轮询没再返回的气球**不会被标成已派送**，而是保留上次的状态并标记「已隐藏」——封榜期间 DOMjudge 会隐藏气球，重测也可能让气球消失，把「消失」当成「已送出」会让志愿者去追一个已经派出的气球。隐藏中的待派送气球会退出派送队列，DOMjudge 重新列出后自动恢复；已隐藏的气球不能标记已派送。注意：单次空响应（例如 DOMjudge 短暂异常返回空数组）会让当轮所有任务瞬间变为「已隐藏」。
- **标记已派送只接受最近一轮轮询里出现过的气球**：对不存在的 id 调用会返回 404 `balloon not found`，既不写盘也不会向 DOMjudge 发请求。
- **升级旧数据目录（重要）**：本版本的气球任务 id 就是 DOMjudge 的 `balloonid`，旧数据里由判题结果合成的行永远匹配不上。启动时会丢弃**不属于当前比赛**的旧行并打一行 INFO；携带当前比赛 ID 的旧行不会被自动清理，只会在界面上永远显示为「已隐藏」。**升级前请先清空数据**（管理台「设置 → 比赛设置 → 清空数据」，或停机删掉 `data/balloon-tasks.json`），然后再填写比赛 ID。

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

> `WorkingDirectory` 必须是 `apps/server`：运行时数据目录 `data/`（相对工作目录）与静态资源 `static/` 都从这里解析。
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

1. `curl http://localhost:8080/wxt/health` 返回 `{"ok":true}`。
2. 浏览器打开 `http://<host>:8080/wxt/`，用 `admin.username` + 明文密码登录成功。
3. 打开「设置 → 比赛设置」：填写本场比赛的比赛 ID 与气球轮询间隔（保存即锁定），按需设置登录时段；保存后 `data/logs/latest.log` 里应出现 `balloon` 模块的轮询记录。
4. 升级安装（沿用旧的 `data/`）先点「清空数据」，再填写比赛 ID。
5. DOMjudge 管理端里把队伍进站/外链 BaseURL 指向 `http://<host>:<port>/wxt`（代理路径为 `/wxt/dj/...`）。
6. 给队伍分配队伍码（管理端导入队伍密码后，通过 TeamStore `setTeamCode`），把队伍码投屏给各队；用一台队伍机器在 `/wxt/dj/verify` 输入队伍码完成登录 + 打印。如需限制登录时段，配置 `teamLogin.start` / `teamLogin.end`（ISO 时间，留空不限）。

## 安全说明

管理端登录 Cookie 未设置 `Secure` 标志：现场部署走的是受信任局域网内的纯 HTTP，浏览器若要求 Secure Cookie 将无法在 HTTP 下送达。若需要把服务暴露到局域网之外，请在前面加一层带 TLS 的反向代理（如 nginx + 证书）。

### 同源校验与 nginx

管理端所有写操作（`/admin/api/*` 的 POST / PUT / DELETE，例如保存设置、清空数据、生成队伍码）都会校验请求来源，防止别的网页借用户浏览器悄悄清空比赛数据：

- 请求带 `Origin`（没有则看 `Referer`）时，其 scheme + host 必须与本服务一致，否则返回 403 `{"error":"cross-origin forbidden"}`；两者都不带的调用（curl、服务端脚本）放行。
- 期望的 host 取 `Host`、`X-Forwarded-Host` 与请求 URL 自身的 host；期望的 scheme 取 `X-Forwarded-Proto`（有则用）否则取请求 URL 的协议。

因此 **nginx 反向代理必须同时转发 Host 与 X-Forwarded-Proto**，否则 TLS 在 nginx 终结时协议对不上，所有保存操作都会 403：

```nginx
proxy_set_header Host              $http_host;
proxy_set_header X-Real-IP         $remote_addr;
proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
proxy_set_header X-Forwarded-Proto $scheme;
proxy_set_header X-Forwarded-Host  $http_host;
```

`script/nginx.conf` 与 `script/2026.conf` 的相关 location 都已带上 `Host $http_host` 与 `X-Forwarded-Proto $scheme`；自建反代（Caddy、Traefik、云厂商负载均衡）请确认同样转发这两项。注意这两份配置里的 location 前缀（`/cxtool`、`/dj-verify`、`/auth-check` 等）是历史站点布局，本服务的路由都在 `/wxt` 下，落地时请把 `proxy_pass` 指向本服务并把前缀改为 `/wxt`，务必保留上面四个 `proxy_set_header`。
