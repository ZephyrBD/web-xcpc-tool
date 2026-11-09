/**
 * Team-facing HTML pages rendered server-side for the verify flow
 * (the examinee types the team code shown on screen). No template engine,
 * no external assets — everything inline so the pages work offline.
 * Palette mirrors the admin UI (Design-md).
 */
import { getVersionInfo } from "../version";

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
<title>Web XCPC Tool - ${escapeHtml(title)}</title>
<style>
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:flex;flex-direction:column;align-items:center;background:#f5f7fa;color:#1f2430;font-family:system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif;padding:24px}
.card{background:#fff;border-radius:16px;padding:40px 36px;max-width:420px;width:100%;margin:auto 0;box-shadow:0 8px 30px rgba(31,36,48,.08);border-top:3px solid ${accent};text-align:center}
h1{margin:0 0 12px;font-size:22px}
p{margin:8px 0;font-size:15px;color:#5b6472;line-height:1.6}
input{width:100%;margin-top:20px;padding:12px 14px;font-size:16px;border:1.5px solid #d9dee7;border-radius:10px;outline:none}
input:focus{border-color:${accent}}
button{margin-top:12px;width:100%;padding:12px;font-size:16px;font-weight:600;color:#fff;background:${accent};border:none;border-radius:10px;cursor:pointer}
button:hover{opacity:.9}
.hint{margin-top:14px;font-size:13px;color:#8a93a3}
.brand{margin-bottom:18px;font-size:14px;font-weight:600;letter-spacing:1px;color:${accent};text-transform:uppercase}
.footer{margin-top:auto;padding-top:24px;font-size:12px;color:#b0b7c3;text-align:center}
</style>
</head>
<body>
<div class="brand">Web XCPC Tool</div>
<div class="card">
${body}
</div>
<div class="footer">Copyright (c) 2018~${getVersionInfo().year} Modding Craft ZBD Studio, Version: ${escapeHtml(getVersionInfo().hash)}</div>
</body>
</html>`;
  return new Response(html, {
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

/** ISO datetime → "YYYY-MM-DD HH:MM:SS" in the server's local time (teams read it against the on-screen clock). */
function formatWindowBound(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function loginWindowLine(teamLogin?: { start: string; end: string }): string {
  // Explicit 不限 placeholders keep the <start>~<end> shape readable in every
  // case; both-missing collapses to just 不限.
  const start = teamLogin?.start ? formatWindowBound(teamLogin.start) : "不限";
  const end = teamLogin?.end ? formatWindowBound(teamLogin.end) : "不限";
  const span = start === "不限" && end === "不限" ? "不限" : `${start}~${end}`;
  return `<p class="hint">登录时段：${escapeHtml(span)}</p>`;
}

/** Team code typed on the form page (HTTP 200). `next` is preserved as a hidden field. */
export function verifyFormPage(
  contextPath: string,
  hint?: string,
  next?: string | null,
  teamLogin?: { start: string; end: string },
): Response {
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
</form>
<p class="hint">${escapeHtml("请查看你屏幕上类似 k3w932jattan 这种形式的代码并输入以登录Domjudge")}</p>
${loginWindowLine(teamLogin)}`,
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

/**
 * Embeds a value inside an inline <script> string literal. HTML entities are
 * NOT decoded inside <script>, so this must not go through escapeHtml —
 * instead the string is JS-escaped (no quote can break out) and every "<" is
 * unicode-escaped so a "</" sequence can never close the script tag early.
 */
function jsString(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/</g, "\\u003c");
}

/**
 * Login request submitted while the window is closed — HTTP 200. Inline JS
 * polls /dj/verify/status every 5s and redirects to /dj/verify/claim once
 * an admin approves; all values are server-rendered, none user-typed.
 */
export function verifyWaitingPage(contextPath: string, reqId: string, next: string | null): Response {
  const nextParam = next ? `&next=${encodeURIComponent(next)}` : "";
  return page(
    "等待登录审批",
    PALETTE.green,
    `<h1>等待管理员审批</h1>
<p>已收到登录请求，请等待监考人员在管理端批准后自动进入比赛系统</p>
<p id="msg" class="hint">等待审批中…</p>
<script>
(function () {
  var base = "${jsString(contextPath)}";
  var reqId = "${jsString(reqId)}";
  var nextParam = "${jsString(nextParam)}";
  var msg = document.getElementById("msg");
  var timer = setInterval(function () {
    fetch(base + "/dj/verify/status?req=" + encodeURIComponent(reqId))
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) {
        if (!d) return;
        if (d.status === "approved") {
          clearInterval(timer);
          msg.textContent = "管理员已批准，正在进入比赛系统…";
          location.href = base + "/dj/verify/claim?req=" + encodeURIComponent(reqId) + nextParam;
        } else if (d.status === "rejected") {
          clearInterval(timer);
          msg.innerHTML = '管理员拒绝了本次登录，可<a href="' + base + '/dj/verify">重新提交</a>';
        } else if (d.status === "claimed") {
          clearInterval(timer);
          msg.textContent = "本次登录已完成，请返回比赛系统";
        }
      })
      .catch(function () {});
  }, 5000);
})();
</script>`,
  );
}

/** The claim link was invalid, already used, or not approved — HTTP 403. */
export function verifyClaimDeniedPage(): Response {
  const res = page(
    "队伍登录",
    PALETTE.red,
    `<h1>队伍登录</h1>
<p>本次登录请求无法继续</p>
<p>请重新提交登录请求或联系监考人员</p>`,
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
