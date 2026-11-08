<script setup lang="ts">
import { computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useSessionStore } from '@/stores/session'

const route = useRoute()
const router = useRouter()
const session = useSessionStore()

const authenticated = computed(() => session.token !== null)

function logout(): void {
  session.logout()
  void router.push('/login')
}

const navItems = [
  { path: '/', label: '总览', accent: 'var(--brand-purple)' },
  { path: '/auth-tasks', label: '认证任务', accent: 'var(--brand-green)' },
  { path: '/jobs', label: '打印 / 气球', accent: 'var(--brand-orange)' },
  { path: '/teams', label: '队伍', accent: 'var(--brand-blue)' },
  { path: '/api-list', label: '接口', accent: 'var(--text-muted)' },
  { path: '/help', label: '帮助', accent: 'var(--text-muted)' },
  { path: '/settings', label: '设置', accent: 'var(--text-muted)' },
]

const accents: Record<string, string> = {
  overview: 'var(--brand-purple)',
  'auth-tasks': 'var(--brand-green)',
  jobs: 'var(--brand-orange)',
  teams: 'var(--brand-blue)',
  'api-list': 'var(--text-muted)',
  help: 'var(--text-muted)',
  settings: 'var(--text-muted)',
}

const accent = computed(() => accents[route.name as string] ?? 'var(--brand-purple)')
</script>

<template>
  <div class="admin-layout" :style="{ '--accent': accent, '--section-tint': `color-mix(in srgb, ${accent} 10%, transparent)` }">
    <header class="layout-header">
      <div class="layout-header-inner">
        <span class="logo-dot" aria-hidden="true"></span>
        <span class="app-title">Web XCPC Tool 管理台</span>
        <nav class="layout-nav">
          <RouterLink
            v-for="item in navItems"
            :key="item.path"
            :to="item.path"
            class="nav-pill"
            :class="{ active: route.path === item.path }"
            :style="route.path === item.path ? { '--accent': item.accent } : undefined"
          >
            {{ item.label }}
          </RouterLink>
        </nav>
        <RouterLink v-if="!authenticated" to="/login" class="login-link">登录</RouterLink>
        <button v-else type="button" class="logout-btn" @click="logout">退出</button>
      </div>
    </header>
    <main class="layout-main">
      <div class="layout-scroll">
        <div class="page-header">
          <h1 class="page-title">{{ route.meta.title ?? '' }}</h1>
          <p class="page-subtitle">有什么需要，这边都能帮你搞定。</p>
        </div>
        <router-view />
      </div>
    </main>
  </div>
</template>

<style scoped>
.admin-layout {
  /* 视口高度固定，页面级滚动一律走内部 .layout-scroll，外层不出现滚动条。 */
  height: 100vh;
  height: 100dvh;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: var(--bg);
}

.layout-header {
  flex-shrink: 0;
  border-bottom: 1px solid var(--border);
  background: var(--bg);
}

.layout-header-inner {
  max-width: 1720px;
  margin: 0 auto;
  padding: 0 40px;
  height: 64px;
  display: flex;
  align-items: center;
  gap: 24px;
}

.logo-dot {
  width: 16px;
  height: 16px;
  border-radius: var(--radius-pill);
  background: var(--brand-purple);
  box-shadow: 4px 0 0 var(--brand-blue), 8px 0 0 var(--brand-orange);
  margin-right: 4px;
  flex-shrink: 0;
}

.app-title {
  font-family: var(--font-heading);
  font-weight: 600;
  font-size: var(--text-17);
  letter-spacing: -0.02em;
}

.layout-nav {
  flex: 1;
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}

.nav-pill {
  text-decoration: none;
  padding: 8px 16px;
  border-radius: var(--radius-pill);
  font-size: var(--text-15);
  font-weight: 500;
  color: var(--text-muted);
  transition: background 0.15s ease;
}

.nav-pill:hover {
  background: var(--bg-alt);
}

.nav-pill.active {
  background: var(--accent);
  color: #ffffff;
}

.login-link {
  text-decoration: none;
  font-size: var(--text-15);
  font-weight: 500;
  border: 1.5px solid var(--brand-purple);
  color: var(--brand-purple);
  padding: 6px 16px;
  border-radius: var(--radius-pill);
}

.logout-btn {
  font-size: var(--text-15);
  font-weight: 500;
  border: 1.5px solid var(--border);
  background: var(--bg);
  color: var(--text-muted);
  padding: 6px 16px;
  border-radius: var(--radius-pill);
  cursor: pointer;
}

.logout-btn:hover {
  border-color: var(--brand-red);
  color: var(--brand-red);
}

.layout-main {
  flex: 1;
  min-height: 0;
  width: 100%;
  max-width: 1720px;
  margin: 0 auto;
  padding: 24px 40px 32px;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: var(--section-tint);
}

.layout-scroll {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
}

.page-header {
  margin-bottom: 24px;
}

.page-title {
  font-size: var(--text-44);
  line-height: 1.1;
}

.page-subtitle {
  margin: 8px 0 0;
  color: var(--text-muted);
  font-size: var(--text-17);
}

@media (max-width: 768px) {
  .layout-header-inner {
    padding: 0 16px;
    flex-wrap: wrap;
    height: auto;
    padding-top: 12px;
    padding-bottom: 12px;
  }

  .layout-main {
    padding: 16px;
  }
  .page-title {
    font-size: var(--text-32);
  }
}
</style>
