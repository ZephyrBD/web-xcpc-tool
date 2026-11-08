import { createRouter, createWebHistory } from 'vue-router'
import LoginPage from '@/pages/LoginPage.vue'
import DashboardPage from '@/pages/DashboardPage.vue'
import AuthTasksPage from '@/pages/AuthTasksPage.vue'
import JobsPage from '@/pages/JobsPage.vue'
import TeamsPage from '@/pages/TeamsPage.vue'
import SettingsPage from '@/pages/SettingsPage.vue'
import ApiListPage from '@/pages/ApiListPage.vue'

export const routes = [
  { path: '/login', name: 'login', component: LoginPage, meta: { title: '登录' } },
  { path: '/', name: 'overview', component: DashboardPage, meta: { title: '总览' } },
  { path: '/auth-tasks', name: 'auth-tasks', component: AuthTasksPage, meta: { title: '认证任务' } },
  { path: '/jobs', name: 'jobs', component: JobsPage, meta: { title: '打印 / 气球' } },
  { path: '/teams', name: 'teams', component: TeamsPage, meta: { title: '队伍' } },
  { path: '/api-list', name: 'api-list', component: ApiListPage, meta: { title: '接口' } },
  { path: '/settings', name: 'settings', component: SettingsPage, meta: { title: '设置' } },
]

const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes,
})

export default router
