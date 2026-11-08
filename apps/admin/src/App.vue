<script setup lang="ts">
import { computed } from 'vue'
import { useRoute } from 'vue-router'
import AdminLayout from '@/layouts/AdminLayout.vue'

const route = useRoute()
// /login 是独立的全视口页面：不带导航与页头，也不走内部滚动容器。
const standalone = computed(() => route.path === '/login')
</script>

<template>
  <router-view v-if="standalone" />
  <AdminLayout v-else />
</template>
