<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { apiFetch } from '@/api'
import { useSessionStore } from '@/stores/session'

interface VersionInfo {
  hash: string
  year: number
}

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
  { path: '/auth', label: '认证管理', accent: 'var(--brand-green)' },
  { path: '/jobs', label: '打印 / 气球', accent: 'var(--brand-orange)' },
  { path: '/teams', label: '队伍', accent: 'var(--brand-blue)' },
  { path: '/api-list', label: '接口', accent: 'var(--brand-red)' },
  { path: '/help', label: '帮助', accent: 'var(--brand-purple)' },
  { path: '/settings', label: '设置', accent: 'var(--brand-green)' },
]

const accents: Record<string, string> = {
  overview: 'var(--brand-purple)',
  'team-codes': 'var(--brand-green)',
  jobs: 'var(--brand-orange)',
  teams: 'var(--brand-blue)',
  'api-list': 'var(--brand-red)',
  help: 'var(--brand-purple)',
  settings: 'var(--brand-green)',
}

const accent = computed(() => accents[route.name as string] ?? 'var(--brand-purple)')

const version = ref<VersionInfo | null>(null)

onMounted(async () => {
  // skipAuthRedirect: the guard already handles auth; a 401 here shouldn't bounce.
  try {
    const s = await apiFetch<{ version?: VersionInfo }>('/admin/api/settings', { skipAuthRedirect: true })
    if (s.version) version.value = s.version
  } catch {
    // 版本信息仅作展示，加载失败就静默省略。
  }
})
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
    <footer v-if="version" class="layout-footer">
      Copyright (c) 2018~{{ version.year }} Modding Craft ZBD Studio, Version: {{ version.hash }}
    </footer>
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
  /* 完全铺满：不设 max-width，全宽下只留固定 40px 边距。 */
  width: 100%;
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
  padding: 24px 40px 32px;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: var(--section-tint);
}

.layout-footer {
  flex-shrink: 0;
  padding: 8px 40px 12px;
  font-size: 12px;
  color: var(--text-muted, #8a93a3);
  text-align: center;
  user-select: none;
}

.layout-scroll {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
}

.page-header {
  margin-bottom: 24px;
  flex-shrink: 0;
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
