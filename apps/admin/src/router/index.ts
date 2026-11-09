import { createMemoryHistory, createRouter, createWebHistory, type Router } from 'vue-router'
import LoginPage from '@/pages/LoginPage.vue'
import DashboardPage from '@/pages/DashboardPage.vue'
import AuthPage from '@/pages/AuthPage.vue'
import JobsPage from '@/pages/JobsPage.vue'
import TeamsPage from '@/pages/TeamsPage.vue'
import SettingsPage from '@/pages/SettingsPage.vue'
import ApiListPage from '@/pages/ApiListPage.vue'
import HelpPage from '@/pages/HelpPage.vue'
import { getToken } from '@/api'

export const routes = [
  { path: '/login', name: 'login', component: LoginPage, meta: { title: '登录' } },
  { path: '/', name: 'overview', component: DashboardPage, meta: { title: '总览' } },
  { path: '/auth', name: 'auth', component: AuthPage, meta: { title: '认证管理' } },
  // 旧书签 /team-codes 重定向到 /auth，地址栏也归一化。
  { path: '/team-codes', redirect: '/auth' },
  { path: '/jobs', name: 'jobs', component: JobsPage, meta: { title: '打印 / 气球' } },
  { path: '/teams', name: 'teams', component: TeamsPage, meta: { title: '队伍' } },
  { path: '/api-list', name: 'api-list', component: ApiListPage, meta: { title: '接口' } },
  { path: '/help', name: 'help', component: HelpPage, meta: { title: '帮助' } },
  { path: '/settings', name: 'settings', component: SettingsPage, meta: { title: '设置' } },
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
