import { createRouter, createWebHistory } from 'vue-router'
import LoginView from '@/views/LoginView.vue'
import OverviewView from '@/views/OverviewView.vue'
import AuthTasksView from '@/views/AuthTasksView.vue'
import JobsView from '@/views/JobsView.vue'
import TeamsView from '@/views/TeamsView.vue'

export const routes = [
  { path: '/login', name: 'login', component: LoginView, meta: { title: '登录' } },
  { path: '/', name: 'overview', component: OverviewView, meta: { title: '总览' } },
  { path: '/auth-tasks', name: 'auth-tasks', component: AuthTasksView, meta: { title: '认证任务' } },
  { path: '/jobs', name: 'jobs', component: JobsView, meta: { title: '打印 / 气球' } },
  { path: '/teams', name: 'teams', component: TeamsView, meta: { title: '队伍' } },
]

const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes,
})

export default router
