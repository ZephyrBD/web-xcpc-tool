<script setup lang="ts">
import { computed } from 'vue'
import { useRoute } from 'vue-router'

const route = useRoute()

const navItems = [
  { path: '/', label: '总览', accent: 'var(--brand-purple)' },
  { path: '/auth-tasks', label: '认证任务', accent: 'var(--brand-green)' },
  { path: '/jobs', label: '打印 / 气球', accent: 'var(--brand-orange)' },
  { path: '/teams', label: '队伍', accent: 'var(--brand-blue)' },
]

const accents: Record<string, string> = {
  overview: 'var(--brand-purple)',
  'auth-tasks': 'var(--brand-green)',
  jobs: 'var(--brand-orange)',
  teams: 'var(--brand-blue)',
}

const accent = computed(() => accents[route.name as string] ?? 'var(--brand-purple)')
</script>

<template>
  <div class="admin-layout" :style="{ '--accent': accent, '--section-tint': `color-mix(in srgb, ${accent} 10%, transparent)` }">
    <header class="layout-header">
      <div class="layout-header-inner">
        <span class="logo-dot" aria-hidden="true"></span>
        <span class="app-title">XCPC Tool 管理台</span>
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
        <RouterLink to="/login" class="login-link">登录</RouterLink>
      </div>
    </header>
    <main class="layout-main">
      <div class="page-header">
        <h1 class="page-title">{{ route.meta.title ?? '' }}</h1>
        <p class="page-subtitle">有什么需要，这边都能帮你搞定。</p>
      </div>
      <router-view />
    </main>
  </div>
</template>

<style scoped>
.admin-layout {
  min-height: 100vh;
  display: flex;
  flex-direction: column;
  background: var(--bg);
}

.layout-header {
  border-bottom: 1px solid var(--border);
  background: var(--bg);
}

.layout-header-inner {
  max-width: 1280px;
  margin: 0 auto;
  padding: 0 32px;
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

.layout-main {
  flex: 1;
  width: 100%;
  max-width: 1280px;
  margin: 0 auto;
  padding: 32px;
  background: var(--section-tint);
}

.page-header {
  margin-bottom: 32px;
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
