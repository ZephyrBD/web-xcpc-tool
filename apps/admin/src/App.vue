<script setup lang="ts">
import { useRoute } from 'vue-router'

const route = useRoute()
const navItems = [
  { path: '/', label: '总览' },
  { path: '/auth-tasks', label: '认证任务' },
  { path: '/jobs', label: '打印 / 气球' },
  { path: '/teams', label: '队伍' },
  { path: '/login', label: '登录' },
]
</script>

<template>
  <el-container class="app-shell">
    <el-header class="app-header">
      <span class="app-title">XCPC Tool 管理台</span>
      <nav class="app-nav">
        <RouterLink
          v-for="item in navItems"
          :key="item.path"
          :to="item.path"
          class="app-nav-link"
          :class="{ active: route.path === item.path }"
        >
          {{ item.label }}
        </RouterLink>
      </nav>
    </el-header>
    <el-main>
      <router-view />
    </el-main>
  </el-container>
</template>

<style scoped>
.app-shell {
  min-height: 100vh;
}

.app-header {
  display: flex;
  align-items: center;
  gap: 24px;
  border-bottom: 1px solid var(--el-border-color-light);
}

.app-title {
  font-weight: 600;
  color: #a259ff;
}

.app-nav {
  flex: 1;
  display: flex;
  gap: 16px;
}

.app-nav-link {
  text-decoration: none;
  color: var(--el-text-color-primary);
  padding: 4px 8px;
  border-radius: 4px;
}

.app-nav-link.active {
  color: #a259ff;
  font-weight: 600;
}
</style>
