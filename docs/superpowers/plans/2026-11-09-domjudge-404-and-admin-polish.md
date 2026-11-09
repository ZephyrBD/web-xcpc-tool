# 计划：DOMjudge 404 根因修复 + 路径收敛 /wxt + 设置页重排 + 帮助文档 + 去兼容

分支：`feat/contest-settings-balloon` 之上新建 `fix/dj-baseurl-404`

---

## 〇、用户裁定（binding）

1. **工具路径只保留 `/wxt`**：`contextPath` 固定为 `/wxt`，不再支持任意前缀。
   - 代码里直接使用常量 `/wxt`，删掉所有 `cfg.contextPath.replace(/\/+$/, "")` 这类动态拼接。
   - `contextPath` 从设置页删除（不再可改）。
   - `settings.json` 里若 `contextPath !== "/wxt"`，启动时强制改写并记一条 INFO。
2. **队伍验证页改为 `/wxt/public/verify`**：
   - `GET /wxt/public/verify`、`/wxt/public/verify/wait`、`/status`、`/claim`
   - 旧路径 `/wxt/dj/verify*` **直接 404**，不重定向、不代理。
3. **完全不做旧版兼容**（用户两次强调：还在开发，改就改）：
   - 不写旧路径重定向，不写旧配置双读，不写数据迁移。
   - `data/` 内旧格式数据直接丢弃并记一条日志。
   - 之后的任何兼容性问题，一律先用 Question 工具确认（已写入全局 AGENTS.md）。

---

## 一、根因（已确认）

### 现象
队伍登录成功后跳到 `/wxt/dj/`，页面变成 DOMjudge 的 CSS 全丢、链接 404 的白底页面。

### 证据

1. 当前配置：`baseUrl = https://www.domjudge.org/demoweb`（带 `/demoweb` 前缀）
2. 官方 demo 实测：
   ```
   GET /demoweb/       -> 302 Location: https://www.domjudge.org/demoweb/public
   GET /demoweb/public -> 200 <title>Scoreboard nwerc2025</title>
   页面内资源全部为绝对路径：/demoweb/css/..., /demoweb/js/jquery.min.js, /demoweb/style_domjudge.css
     /demoweb/js/jquery.min.js -> 200 ✅
     /js/jquery.min.js         -> 404 ❌
   ```
3. 我们的代码：
   - `proxy.ts:151` `redirect:"manual"` 原样透传 302 与 Location，未改写。
   - `proxy.ts:201` 根代理把 `/demoweb/js/x.js` 转发成 `{baseUrl}/demoweb/js/x.js` → 404。
   - `proxy.ts:84` 早已把上游 Cookie 的 `Path` 强改 `/`，说明前缀问题以前只补了 Cookie。

### 结论
`baseUrl` 带路径前缀时，DOMjudge 自己生成的绝对路径（HTML href/src、302 Location）全部失效。
这是"前缀部署"的通病，不是 demo 特有。

---

## 二、目标路由表（先匹配先胜）

**工具只占 `/wxt`，DOMjudge 占站点根 `/`。**
DOMjudge 生成的绝对路径（原本带 `/demoweb` 前缀）统去掉前缀，落到根路径，
由根代理转发到 `{baseUrl}/...`。

```
1. /wxt/public/verify*      -> 本站队伍验证页（wait/status/claim）
2. /wxt/admin*              -> 管理台 SPA 与 /wxt/admin/api/*
3. /wxt/print               -> 打印回调
4. /wxt/* 其余               -> 管理台静态资源 / 前端路由兜底
5. 其余一切（不在 /wxt 下）  -> DOMjudge 根代理（team token 校验 + 响应改写 + 登录注入）
```

**示例**（baseUrl = `https://www.domjudge.org/demoweb`）：

| 浏览器请求 | 上游 | 说明 |
|---|---|---|
| `/` | `{baseUrl}/` | 302 → `https://www.domjudge.org/demoweb/public` |
| `/public` | `{baseUrl}/public` | 改写后的 Location 落点 |
| `/js/jquery.min.js` | `{baseUrl}/js/jquery.min.js` | HTML 中的 `/demoweb/js/...` 已改写为 `/js/...` |
| `/wxt/settings` | 管理台 SPA | 不受影响 |
| `/wxt/public/verify` | 本站验证页 | 不受影响 |

**结论**：不再需要 `/wxt/dj/*` 代理层，`handleDjProxy`、`/dj/*` 全部删除；
验证成功后默认跳转 `/`。

---

## 三、改动清单

### Task 0：路径收敛为常量 `/wxt`，验证页迁移，删除 `/dj` 代理层

文件：`config.ts`、`server.ts`、`proxy.ts`、`index.ts`、`pages/teamPages.ts`、相关测试

1. 新增 `export const CONTEXT_PATH = "/wxt"`，全仓替换动态拼接。
2. `config.ts`：`contextPath` 保留为只读归一化字段（读入即强制 `/wxt`，不一致记 INFO）。
3. 验证页路由 `/dj/verify*` → `/wxt/public/verify*`（含 wait/status/claim），
   页面内所有链接、`next` 跳转同步改。
4. 登录成功后的默认跳转：`next ?? "/"`。
5. **删除 `handleDjProxy` 与 `app.all("/dj/*")`**：DOMjudge 只走根代理。
6. 打印回调 `/dj/print` → `/wxt/print`（管理台文档与 ApiListPage 同步）。
7. 设置页与 `safeSettingsView` 去掉 `contextPath` 暴露（Task 2 落实 UI）。
8. 测试：`/wxt/public/verify` 200、旧 `/dj/verify` 走根代理（会 302 到验证页，
   因为无 token），`/wxt/print` 可达，SPA 静态资源不被代理吞掉。

### Task 1：DOMjudge 前缀改写（核心修复）

文件：`apps/server/src/domjudge/proxy.ts`、`proxy.test.ts`

1. `rewriteUpstreamBody(res, baseUrl)`：
   - 仅处理 `text/html` / `text/css` / `application/javascript` / `text/javascript`
   - 把 `{prefixPath}/x`（含 `"/demoweb/`、`'/demoweb/`、`url(/demoweb/`、裸 `/demoweb/`）
     改写为 `/x`（去前缀）
   - 绝对 URL `https://host/demoweb/x` 也改写为 `/x`
   - 若响应带 `content-encoding`（gzip/br）且无法安全解码：**不改写**，记一条 WARN
2. `Location` 改写：`{origin}{prefixPath}/x` 或 `{prefixPath}/x` → `/x`
3. baseUrl 无前缀时：**前缀为空，跳过一切改写**（零开销、零行为变化）
4. 测试（先失败后通过）：
   - 带前缀 baseUrl：`/` 上游 302 → Location 改写成 `/public`
   - HTML 里 `/demoweb/js/x.js` → `/js/x.js`
   - `/js/x.js` 代理到 `{baseUrl}/js/x.js`
   - 二次代理不产生双前缀（`/demoweb/demoweb/`）
   - 回归：无前缀 baseUrl 时行为与现在完全一致

### Task 2：设置页重排

文件：`apps/admin/src/pages/SettingsPage.vue`（+ 测试）

现状问题：一张「比赛设置」卡片塞了比赛 ID、轮询间隔、登录时段、清空数据四组内容，
纵向过长、层级混乱；下方三张卡片被挤在左侧。

方案：
1. 卡片内分区（`field-group` + 小标题 + 分隔线）：
   - **比赛绑定**：比赛 ID（含锁定徽章与说明）+ 轮询间隔
   - **队伍码登录时段**：开始 / 结束 / 清除
   - **危险操作**：清空数据（折叠）
2. 清空数据默认折叠：只显示一行「危险操作 · 清空数据」，展开后才是删除/保留清单、
   确认输入框、按钮、结果统计。
3. 锁定提示与解锁路径合并为同一条视觉块，避免"提示"和"操作"分居两处。
4. 结果统计独立成浅色条，不混在表单字段流里。
5. 删除 `contextPath` 相关字段与"访问前缀需重启"的文案（已固定 `/wxt`）；
   重启说明只保留端口与 JWT 密钥。
6. 布局：`settings-grid` 宽屏两列，「比赛设置」跨整行，其余卡片两列均分；
   窄屏单列。
7. 测试：折叠默认收起、展开后确认词门槛、锁定态、结果条、文案无"访问前缀"。

### Task 3：帮助文档更新

文件：`apps/admin/src/pages/HelpPage.vue`（+ 测试）、`README.md`、`script/deploy/deploy.md`

要补：
1. 工具固定挂在 `/wxt`，验证页地址 `/wxt/public/verify`（旧 `/wxt/dj/verify` 已废弃）。
2. 比赛 ID 只能设一次；换比赛必须清空数据；清空后重新填写保存，气球自动开始拉取。
3. 气球任务只来自 `GET /api/v4/contests/{id}/balloons`；`已隐藏`(stale) 的含义与限制。
4. `baseUrl` 带路径前缀（如 `/demoweb`）现已支持；反代必须转发 `Host` 与 `X-Forwarded-Proto`。
5. 日志：`data/logs/latest.log`、启动截断、格式、密码脱敏规则。
6. 哪些设置要重启：端口、JWT 密钥；其余实时生效。
7. 旧数据不再迁移：升级时旧格式行会被丢弃并记 INFO。

### Task 4：删除旧版兼容代码（无过渡）

原则：不写过渡层、不写双读、不写重定向。

| 位置 | 内容 | 处理 |
|---|---|---|
| `index.ts:118-148` + `proxy.ts:209-222` | `/cxtool/*` → 301 旧 SPA 兼容 | 整段删除（函数、调用点、测试） |
| `store/dataRoot.ts` | `data/data/` 自动迁移 | 整段删除；发现旧目录只 WARN，不迁移 |
| `admin/settings.ts` | 完整 settings.json 陈旧 hash 的运行时兜底 | 简化：文件即唯一事实来源 |
| `config.ts` + 全仓 | `contextPath` 动态拼接 | 收敛为常量 `/wxt` |
| `/wxt/dj/verify*` | 旧验证路径 | 显式 404 |
| `balloon/service.ts:174` | 丢弃重构前旧格式行的校验 | **保留**（脏数据防御，不是兼容层） |
| `proxy.ts:84` Cookie 改写 | 去 Secure / 改 Path | **保留**（局域网 HTTP 必需） |
| `cxtool-token` / `cxtool-admin` | 当前 cookie 名 | 不动 |

> 删除前 grep 全仓逐个确认引用（含测试），一并删除。

### Task 5：验证

1. `apps/server`：`bun test` + `bunx tsc --noEmit`（基线 410）
2. `apps/admin`：`bun test` + `bunx vue-tsc --noEmit` + `bun run build`（基线 159）
3. 临时端口（非 8080）冒烟：
   - 带前缀 baseUrl：`/wxt/dj/` 落地页面样式与脚本全部 200，无 404
   - `/wxt/public/verify` 正常；`/wxt/dj/verify` 返回 404
   - 管理台 `/wxt/settings` 与静态资源不受影响
   - 设置页折叠/确认词、帮助页渲染
4. 逐任务复审 + 整分支复审（沿用 SDD 流程）

---

## 四、已知取舍

- 响应体改写需读取整个 body：仅对小型文本资源（HTML/CSS/JS）生效，PDF/图片/源码原样流式透传。
- `content-encoding` 无法解码时降级不改写（记 WARN），该页面会退化为"样式丢失"，但不会输出坏响应。
- 端口与 JWT 密钥仍需重启；其余设置实时生效。
