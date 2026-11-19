import type { Component } from 'vue'
import LoginPage from '@/view/login/index.vue'
import OverviewPage from '@/view/overview/index.vue'
import AuthPage from '@/view/auth/index.vue'
import JobsPage from '@/view/jobs/index.vue'
import TeamsPage from '@/view/teams/index.vue'
import ApiListPage from '@/view/api-list/index.vue'
import HelpPage from '@/view/help/index.vue'
import SettingsPage from '@/view/settings/index.vue'

/**
 * 菜单记录（docs/frontend/02 §8）：管理台为单端项目，省去端前缀层。
 * 登录页是独立全视口页，不进菜单，单独在 router 里注册。
 */
export interface MenuRecord {
  path: string
  name: string
  component: Component
  title: string
  /** 菜单不可直达的子页（如重定向占位）标记 hidden */
  hidden?: boolean
}

export const menu: MenuRecord[] = [
  { path: '/', name: 'overview', component: OverviewPage, title: '总览' },
  { path: '/auth', name: 'auth', component: AuthPage, title: '认证管理' },
  { path: '/jobs', name: 'jobs', component: JobsPage, title: '打印 / 气球' },
  { path: '/teams', name: 'teams', component: TeamsPage, title: '队伍' },
  { path: '/api-list', name: 'api-list', component: ApiListPage, title: '接口' },
  { path: '/help', name: 'help', component: HelpPage, title: '帮助' },
  { path: '/settings', name: 'settings', component: SettingsPage, title: '设置' },
]

export const loginRoute: MenuRecord = {
  path: '/login',
  name: 'login',
  component: LoginPage,
  title: '登录',
}
