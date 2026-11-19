import { createMemoryHistory, createRouter, createWebHistory, type Router } from 'vue-router'
import { loginRoute, menu, type MenuRecord } from '@/api/menu'
import { getToken } from '@/api'

function toRoute(record: MenuRecord) {
  return {
    path: record.path,
    name: record.name,
    component: record.component,
    meta: { title: record.title, hidden: record.hidden ?? false },
  }
}

export const routes = [
  toRoute(loginRoute),
  ...menu.map(toRoute),
  // 旧书签 /team-codes 重定向到 /auth，地址栏也归一化。
  { path: '/team-codes', redirect: '/auth' },
]

// 退出登录或 token 过期后，任何非 /login 页面一律回到登录页。
export function authGuard(to: { path: string }): boolean | string {
  if (to.path !== '/login' && !getToken()) return '/login'
  return true
}

export function createAppRouter(history: ReturnType<typeof createWebHistory> | ReturnType<typeof createMemoryHistory>): Router {
  const router = createRouter({ history, routes })
  router.beforeEach(authGuard)
  return router
}

const router = createAppRouter(createWebHistory(import.meta.env.BASE_URL))

export default router
