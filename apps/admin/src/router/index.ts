import { createRouter, createWebHistory } from 'vue-router'
import LoginView from '@/views/LoginView.vue'
import OverviewView from '@/views/OverviewView.vue'
import AuthTasksView from '@/views/AuthTasksView.vue'
import JobsView from '@/views/JobsView.vue'
import TeamsView from '@/views/TeamsView.vue'

export const routes = [
  { path: '/login', name: 'login', component: LoginView },
  { path: '/', name: 'overview', component: OverviewView },
  { path: '/auth-tasks', name: 'auth-tasks', component: AuthTasksView },
  { path: '/jobs', name: 'jobs', component: JobsView },
  { path: '/teams', name: 'teams', component: TeamsView },
]

const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes,
})

export default router
