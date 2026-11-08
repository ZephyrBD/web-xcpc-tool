/**
 * Team-facing HTML pages rendered server-side for the verify flow
 * (the examinee types the team code shown on screen). No template engine,
 * no external assets — everything inline so the pages work offline.
 * Palette mirrors the admin UI (Design-md).
 */

const PALETTE = {
  green: "#0acf83",
  orange: "#f24e1e",
  red: "#ff7262",
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

/** Team code typed on the form page (HTTP 200). `next` is preserved as a hidden field. */
export function verifyFormPage(contextPath: string, hint?: string, next?: string | null): Response {
  return page(
    "队伍登录",
    PALETTE.green,
    `<h1>队伍登录</h1>
<p>请输入屏幕上显示的队伍码开始登录</p>
${hint ? `<p>${escapeHtml(hint)}</p>` : ""}
<form method="get" action="${escapeHtml(contextPath)}/dj/verify">
${next ? `<input type="hidden" name="next" value="${escapeHtml(next)}">` : ""}
<input name="code" placeholder="请输入队伍码">
<button type="submit">开始登录</button>
</form>`,
  );
}

/** The typed code does not match any team — HTTP 403 kept for semantics. */
export function verifyMissPage(): Response {
  const res = page(
    "队伍登录",
    PALETTE.orange,
    `<h1>队伍登录</h1>
<p>队伍码不正确</p>
<p>请核对屏幕上显示的队伍码后重新输入</p>`,
  );
  return new Response(res.body, { status: 403, headers: res.headers });
}

/** Upstream (DOMjudge) is unreachable — HTTP 502 with a refresh link for teams. */
export function upstreamErrorPage(): Response {
  const res = page(
    "比赛系统暂时没有响应",
    PALETTE.red,
    `<h1>比赛系统暂时没有响应</h1>
<p>可能是网络波动，请刷新重试；若持续出现请联系监考人员</p>
<button type="button" onclick="location.reload()">刷新重试</button>`,
  );
  return new Response(res.body, { status: 502, headers: res.headers });
}

function friendlyTime(iso: string): string {
  return new Date(iso).toLocaleString("zh-CN", { hour12: false });
}

/** The code matched but the current time is outside the allowed login window — HTTP 403. */
export function verifyWindowPage(window: { start: string; end: string }): Response {
  let span: string;
  if (window.start && window.end) {
    span = `${friendlyTime(window.start)} ~ ${friendlyTime(window.end)}`;
  } else if (window.start) {
    span = `${friendlyTime(window.start)} 之后`;
  } else {
    span = `${friendlyTime(window.end)} 之前`;
  }
  const res = page(
    "队伍登录",
    PALETTE.red,
    `<h1>队伍登录</h1>
<p>当前不在允许登录的时段内</p>
<p>允许登录时段：${escapeHtml(span)}</p>`,
  );
  return new Response(res.body, { status: 403, headers: res.headers });
}
