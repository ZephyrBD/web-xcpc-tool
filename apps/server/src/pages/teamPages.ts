/**
 * Team-facing HTML pages rendered server-side for the OMS exam client
 * (QtWebEngine). No template engine, no external assets — everything inline
 * so the pages work offline. Palette mirrors the admin UI (Design-md).
 */

const PALETTE = {
  green: "#0acf83",
  orange: "#f24e1e",
  purple: "#a259ff",
  red: "#ff7262",
  blue: "#1abcfe",
};

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function page(title: string, accent: string, body: string): Response {
  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#f5f7fa;color:#1f2430;font-family:system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif;padding:24px}
.card{background:#fff;border-radius:16px;padding:40px 36px;max-width:420px;width:100%;box-shadow:0 8px 30px rgba(31,36,48,.08);border-top:3px solid ${accent};text-align:center}
h1{margin:0 0 12px;font-size:22px}
p{margin:8px 0;font-size:15px;color:#5b6472;line-height:1.6}
.exam{display:inline-block;margin-top:16px;padding:6px 16px;border-radius:999px;background:${accent}1a;color:${accent};font-size:14px;font-weight:600;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
input{width:100%;margin-top:20px;padding:12px 14px;font-size:16px;border:1.5px solid #d9dee7;border-radius:10px;outline:none}
input:focus{border-color:${accent}}
button{margin-top:12px;width:100%;padding:12px;font-size:16px;font-weight:600;color:#fff;background:${accent};border:none;border-radius:10px;cursor:pointer}
button:hover{opacity:.9}
</style>
</head>
<body>
<div class="card">
${body}
</div>
</body>
</html>`;
  return new Response(html, {
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

/** Recognition missed (no strategy matched, or no task at all) — HTTP 403 kept for semantics. */
export function verifyMissPage(examNum: string): Response {
  const res = page(
    "队伍认证",
    PALETTE.orange,
    `<h1>队伍认证</h1>
<p>未识别到考位信息</p>
<p>请联系监考人员检查认证配置</p>
${examNum ? `<span class="exam">考号：${escapeHtml(examNum)}</span>` : ""}`,
  );
  return new Response(res.body, { status: 403, headers: res.headers });
}

/** Task recognized but still waiting for proctor approval — HTTP 200, page self-explains. */
export function verifyPendingPage(examNum: string): Response {
  return page(
    "队伍认证",
    PALETTE.blue,
    `<h1>队伍认证</h1>
<meta http-equiv="refresh" content="5">
<p>认证申请已提交，等待监考批准…</p>
<p>批准后本页面会每 5 秒自动刷新，进入比赛系统，请稍候。</p>
${examNum ? `<span class="exam">考号：${escapeHtml(examNum)}</span>` : ""}`,
  );
}

/** Task was rejected by the proctor — HTTP 403. */
export function verifyRejectedPage(examNum: string): Response {
  const res = page(
    "队伍认证",
    PALETTE.red,
    `<h1>队伍认证</h1>
<p>认证被拒绝，请联系监考人员</p>
${examNum ? `<span class="exam">考号：${escapeHtml(examNum)}</span>` : ""}`,
  );
  return new Response(res.body, { status: 403, headers: res.headers });
}

/** Missing/invalid cxtool-token — lets the team self-start by entering their exam number (HTTP 401). */
export function teamLoginPage(contextPath: string): Response {
  const res = page(
    "队伍登录",
    PALETTE.green,
    `<h1>队伍登录</h1>
<p>输入考号开始认证</p>
<form method="get" action="${escapeHtml(contextPath)}/dj/verify">
<input name="examNum" placeholder="请输入考号" required>
<button type="submit">开始认证</button>
</form>`,
  );
  return new Response(res.body, { status: 401, headers: res.headers });
}
