import { ApiError } from '@/api'

/** 从任意失败的请求里取出可展示的中文说明；取不到时返回空串。 */
function bodyMessage(err: unknown): string {
  // 只认 HTTP 错误体：本地 JS 异常（TypeError 等）的文案是英文，不该挤掉中文兜底。
  const body = err instanceof ApiError ? err.body : null
  if (!body || typeof body !== 'object') return ''
  const { message, error, reason } = body as { message?: unknown; error?: unknown; reason?: unknown }
  for (const value of [message, error, reason]) {
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return ''
}

/**
 * 接口报错里的中文说明：优先 message，其次 error（部分接口用 reason），
 * 最后才退回调用方给的兜底文案。服务端说了什么就展示什么，不吞成通用文案。
 */
export function serverMessage(err: unknown, fallback: string): string {
  return bodyMessage(err) || fallback
}

/** 同 serverMessage，但服务端没给说明时返回空串——调用方自行决定是否提示。 */
export function serverMessageOrEmpty(err: unknown): string {
  return bodyMessage(err)
}
