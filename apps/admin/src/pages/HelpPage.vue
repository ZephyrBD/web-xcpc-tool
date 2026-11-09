<script setup lang="ts">
interface HelpSection {
  title: string
  accent: string
  blocks: Array<{ note?: string; lines: Array<{ text?: string; code?: string }> }>
}

const sections: HelpSection[] = [
  {
    title: '打印回调对接',
    accent: 'var(--brand-orange)',
    blocks: [
      {
        note: 'DOMjudge 评审完成后会调用打印回调：本工具收到请求后保存 PDF 到服务端，管理端在「打印 / 气球」页面查看并打印。',
        lines: [],
      },
      {
        note: 'DOMjudge 的打印脚本需要向下面这个地址发起 POST 请求，并在请求头中携带在「设置」页生成的令牌：',
        lines: [
          { text: '接口地址：' },
          { code: 'POST http://<本工具地址>/wxt/dj/print' },
          { text: '请求头：' },
          { code: 'org.domjudge.print-token: <在设置页生成的令牌>' },
          { text: 'multipart 表单字段（名称必须完全一致）：' },
          { code: 'location（座位/位置）、teamname（队伍名）、teamid（队伍 ID）、original（原始文件名）、file（PDF 文件）' },
        ],
      },
      {
        note: '可以直接用 curl 验证回调是否打通（假数据，替换成实际地址和令牌即可）：',
        lines: [
          { code: 'curl -X POST http://127.0.0.1:8080/wxt/dj/print \\' },
          { code: '  -H "org.domjudge.print-token: <你的令牌>" \\' },
          { code: '  -F "location=I1" -F "teamname=VILNIUS TECH 1" -F "teamid=111" \\' },
          { code: '  -F "original=main.c.pdf" -F "file=@main.c.pdf"' },
        ],
      },
      {
        note: '兼容说明：script/print.sh 是发给本工具打印回调的客户端脚本，参数顺序为 Location TeamName teamid FilePath OriginalFileName。只要把脚本里的 PRINT_API 指向本工具的 /wxt/dj/print、API_TOKEN 填成设置页生成的令牌，即可直接对接。',
        lines: [],
      },
    ],
  },
  {
    title: '队伍码登录（verify）',
    accent: 'var(--brand-green)',
    blocks: [
      {
        note: '队伍在 GET /dj/verify 页面输入「队伍码」登录：本工具校验队伍码（大小写不敏感），并检查当前是否在「设置 → 登录时段」允许的时段内；通过后签发 cxtool-token Cookie，队伍浏览器直接进入 /dj/ 反代访问 DOMjudge，无需再输入 DOMjudge 账号密码。队伍访问 DOMjudge 的 /login 时，本工具会在请求头注入 X-DOMjudge-Login（用户名）/ X-DOMjudge-Pass（base64 密码），自动完成登录。前提：DOMjudge 配置项 auth_methods 必须包含 xheaders，否则注入的头会被忽略，考生看到的是普通登录页。',
        lines: [{ code: 'GET /dj/verify?code=<队伍码>' }],
      },
      {
        note: '队伍码在管理台「认证管理」页面生成：可为单个队伍重新生成（旧码立即失效），也可一键为所有未分配的队伍批量生成；「一键配置密码」会通过 DOMjudge 管理员 API 重置对应队伍的 DOMjudge 密码并加密存回本工具，用于免密注入登录。导出 CSV 包含解密后的 DOMjudge 密码，请妥善保管。每次成功登录都会记录到「认证管理 → 登录历史」。登录时段之外（未开始或已结束）队伍输入队伍码会进入等待页；管理员在「认证管理 → 登录审批」中同意后该队伍自动完成登录，审批仅当次有效。OMS 检测与其它身份核验流程均已移除。',
        lines: [],
      },
    ],
  },
  {
    title: 'DOMjudge 对接配置',
    accent: 'var(--brand-blue)',
    blocks: [
      {
        note: '在「设置」页填写 DOMjudge 的 Base URL：指向 DOMjudge 本身的地址，不带 /api 后缀。拼接规则：本工具按 baseUrl + /api/v4/contests/... 调 DOMjudge API；队伍浏览器访问的 DOMjudge 页面则通过本工具的 /wxt/dj/... 反代到 baseUrl + /...。',
        lines: [],
      },
      {
        note: '部署约定：生产环境中 DOMjudge 侧的「外部 BaseURL」应指向本工具的 /wxt 路径，这样队伍从队伍码登录入口进站后，所有 DOMjudge 页面链接都会经过本工具反代。',
        lines: [],
      },
      {
        note: '账号说明：「设置」页的 DOMjudge 管理员用户名/密码是 DOMjudge 平台的账号（用于本工具调用 DOMjudge 的 API，如同步队伍、拉取判题结果），不是本工具自己的登录账号。管理端账号是本工具自己的管理员账号（登录本管理台用），与 DOMjudge 无关；登录密码可在「设置」页修改，保存后立即生效。端口、访问前缀、JWT 密钥是例外，修改后需重启服务并重新登录。',
        lines: [],
      },
      {
        note: '「设置 → 比赛设置」集中维护比赛 ID（contestId）、气球轮询间隔与队伍登录时段。比赛 ID 保存后即锁定：气球任务绑定在这场比赛上，不能再改成别的比赛；如需更换，请在「比赛设置」里输入「清空」确认后点「清空数据」，它会删除队伍、队伍账号密码、队伍码、登录历史、审批记录、打印任务与留档源码/PDF、气球任务并把比赛 ID 置空，其余设置与 secret.key 保留。「队伍管理」页的「从 DOMjudge 同步」直接使用这里配置的比赛 ID，无需重复填写。打印回调令牌可在设置页一键生成，保存后立即生效。',
        lines: [],
      },
    ],
  },
  {
    title: '气球流程',
    accent: 'var(--brand-purple)',
    blocks: [
      {
        note: '气球队列直接读取 DOMjudge 的气球接口 /contests/{id}/balloons，不再由判题结果合成；管理端可在「打印 / 气球」页面打印小票、标记已送。同一场比赛的气球状态以 DOMjudge 为准，每次轮询双向同步（DOMjudge 撤销 done，本地也退回待派送）。若某个气球在列表中消失（例如封榜后 DOMjudge 隐藏、或重测撤销了提交），它不会被标记为已派送，而是显示「已隐藏」并暂时离开待派送队列，等 DOMjudge 重新列出后自动恢复；已隐藏的气球不能标记已派送。「标记已派送」只接受最近一轮轮询里出现过的气球 id，其它 id 会返回 404 balloon not found。任务实时推送到管理端 SSE 事件流（/admin/api/events），无需手动刷新页面。',
        lines: [],
      },
      {
        note: '从旧数据目录升级：旧版本合成的气球任务 id 是提交 id，永远匹配不上 DOMjudge 的气球 id，启动时只会丢弃不属于当前比赛的行并输出一行日志，携带当前比赛 ID 的旧行会一直显示「已隐藏」。请先到「设置 → 比赛设置 → 清空数据」清空，再填写本场比赛 ID。',
        lines: [],
      },
    ],
  },
  {
    title: '比赛设置 · 重启项 · 日志',
    accent: 'var(--brand-red)',
    blocks: [
      {
        note: '比赛 ID 写一次即锁定：气球任务、打印留档、队伍同步都按它归属，保存后不能再改成别的比赛（保存同一个值始终允许）。保存其它值时服务端会拒绝并提示「比赛 ID 已锁定，设置后不可修改；如需更换请先清空比赛数据」。唯一解锁方式是在「设置 → 比赛设置」输入确认词「清空」后点「清空数据」：它会删除队伍、账号密码、队伍码、登录历史、审批记录、打印任务与留档源码/PDF、气球任务，并把比赛 ID 置空；settings.json 其余设置与 secret.key 保留。清空后填写新的比赛 ID 并保存，气球轮询立即自动开始。',
        lines: [],
      },
      {
        note: '以下设置在保存后立即生效，无需重启：DOMjudge 地址/账号/超时、打印令牌、管理端账号密码、登录时段（立即影响队伍登录）、气球比赛 ID 与轮询间隔。需要重启并重新登录的只有三项——端口、访问前缀、JWT 密钥，它们由进程在启动时绑定，JWT 密钥更换还会让现有的管理端与队伍登录状态立即失效。',
        lines: [],
      },
      {
        note: '运行日志写在 data/logs/latest.log（与 settings.json 同级），只保留这一个文件，每次启动清空，需要留档请自行复制。每行格式为「日 时:分:秒 模块名 [级别] 消息」，级别为 D/I/W/E/C；终端输出带颜色，日志文件是纯文本。管理端密码在日志文件中显示为 ********，只有启动横幅的终端输出是明文。现场排查气球/同步问题时先看这个文件的 balloon、proxy 等模块。',
        lines: [
          { code: '09 14:03:07   startup [I] Web XCPC Tool <version>' },
          { code: '09 14:03:44   balloon [E] poll failed for contest 3: DOMjudge API error: ... (status 0)' },
        ],
      },
      {
        note: '通过 nginx 等反向代理访问本管理端时，代理必须同时转发 Host 与 X-Forwarded-Proto：管理端的保存操作会做同源校验，TLS 在代理上终结而协议头缺失时，所有保存都会返回 403 cross-origin forbidden。',
        lines: [],
      },
    ],
  },
]
</script>

<template>
  <div class="help-page page-fill">
    <section v-for="s in sections" :key="s.title" class="help-section">
      <h2 class="section-title" :style="{ color: s.accent }">{{ s.title }}</h2>
      <div v-for="(b, bi) in s.blocks" :key="bi" class="help-block">
        <p v-if="b.note" class="block-note">{{ b.note }}</p>
        <pre v-for="(l, li) in b.lines" :key="li" class="block-line"><code v-if="l.code">{{ l.code }}</code><span v-else>{{ l.text }}</span></pre>
      </div>
    </section>
  </div>
</template>

<style scoped>
.help-section {
  margin-bottom: 28px;
}

.section-title {
  margin: 0 0 10px;
  font-size: var(--text-17);
  font-weight: 600;
}

.help-block {
  border: 1px solid var(--border);
  border-radius: var(--radius-card);
  background: var(--bg-alt);
  padding: 14px 16px;
  margin-bottom: 12px;
}

.block-note {
  margin: 0 0 8px;
  font-size: var(--text-13);
  color: var(--text-muted);
  line-height: 1.7;
}

.block-line {
  margin: 0;
  padding: 2px 0;
  font-family: var(--font-mono);
  font-size: 12.5px;
  color: var(--text);
  line-height: 1.7;
  white-space: pre-wrap;
}

.block-line code {
  background: color-mix(in srgb, var(--text-muted) 10%, transparent);
  border-radius: 4px;
  padding: 1px 6px;
}
</style>
