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
          { code: 'POST http://<本工具地址>/cxtool/dj/print' },
          { text: '请求头：' },
          { code: 'org.domjudge.print-token: <在设置页生成的令牌>' },
          { text: 'multipart 表单字段（名称必须完全一致）：' },
          { code: 'location（座位/位置）、teamname（队伍名）、teamid（队伍 ID）、original（原始文件名）、file（PDF 文件）' },
        ],
      },
      {
        note: '可以直接用 curl 验证回调是否打通（假数据，替换成实际地址和令牌即可）：',
        lines: [
          { code: 'curl -X POST http://127.0.0.1:8080/cxtool/dj/print \\' },
          { code: '  -H "org.domjudge.print-token: <你的令牌>" \\' },
          { code: '  -F "location=I1" -F "teamname=VILNIUS TECH 1" -F "teamid=111" \\' },
          { code: '  -F "original=main.c.pdf" -F "file=@main.c.pdf"' },
        ],
      },
      {
        note: '兼容说明：script/print.sh 是发往旧 Java 版的客户端脚本，参数顺序为 Location TeamName teamid FilePath OriginalFileName。新工具的接口字段与旧版一致，只要把脚本里的 PRINT_API 指到本工具的 /cxtool/dj/print、API_TOKEN 填成设置页生成的令牌，即可直接对接。',
        lines: [],
      },
    ],
  },
  {
    title: '队伍码登录（verify）',
    accent: 'var(--brand-green)',
    blocks: [
      {
        note: '队伍在 GET /dj/verify 页面输入「队伍码」登录：本工具校验队伍码（大小写不敏感），并检查当前是否在「设置 → 登录时段」允许的时段内；通过后签发 cxtool-token Cookie，队伍浏览器直接进入 /dj/ 反代访问 DOMjudge，无需再输入 DOMjudge 账号密码。队伍访问 DOMjudge 的 /login 时，本工具会在请求头注入 X-DOMjudge-Login / X-DOMjudge-Pass，自动完成登录。',
        lines: [{ code: 'GET /dj/verify?code=<队伍码>' }],
      },
      {
        note: '队伍码在管理台「队伍码」页面生成：可为单个队伍重新生成（旧码立即失效），也可一键为所有未分配的队伍批量生成；「一键配置密码」会通过 DOMjudge 管理员 API 重置对应队伍的 DOMjudge 密码并加密存回本工具，用于免密注入登录。导出 CSV 包含解密后的 DOMjudge 密码，请妥善保管。每次成功登录都会记录到「队伍码 → 登录历史」。OMS 检测与认证审批流程已移除，现在只需要队伍码即可登入。',
        lines: [],
      },
    ],
  },
  {
    title: 'DOMjudge 对接配置',
    accent: 'var(--brand-blue)',
    blocks: [
      {
        note: '在「设置」页填写 DOMjudge 的 Base URL：指向 DOMjudge 本身的地址，不带 /api 后缀。拼接规则：本工具按 baseUrl + /api/v4/contests/... 调 DOMjudge API；队伍浏览器访问的 DOMjudge 页面则通过本工具的 /cxtool/dj/... 反代到 baseUrl + /...。',
        lines: [],
      },
      {
        note: '部署约定：生产环境中 DOMjudge 侧的「外部 BaseURL」应指向本工具的 /cxtool 路径，这样队伍从队伍码登录入口进站后，所有 DOMjudge 页面链接都会经过本工具反代。',
        lines: [],
      },
      {
        note: '账号说明：「设置」页的 DOMjudge 管理员用户名/密码是 DOMjudge 平台的账号（用于本工具调用 DOMjudge 的 API，如同步队伍、拉取判题结果），不是本工具自己的登录账号。管理端账号是本工具自己的管理员账号（登录本管理台用），与 DOMjudge 无关；登录密码可在「设置」页修改，保存后重启服务生效。',
        lines: [],
      },
      {
        note: '气球服务同样在设置页配置比赛 ID（contestId）与轮询间隔；打印回调令牌可在设置页一键生成，保存后重启生效。',
        lines: [],
      },
    ],
  },
  {
    title: '气球流程',
    accent: 'var(--brand-purple)',
    blocks: [
      {
        note: '气球服务按轮询间隔调 DOMjudge judgements 接口，发现 AC（判题结果为 solved）后自动生成气球任务；管理端可在「打印 / 气球」页面打印小票、标记已送。任务实时推送到管理端 SSE 事件流（/admin/api/events），无需手动刷新页面。',
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
