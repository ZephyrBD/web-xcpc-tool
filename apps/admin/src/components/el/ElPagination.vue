<template>
  <ElPagination v-bind="$attrs" :class="['el_pagination', $attrs.class as string | undefined]">
    <slot />
  </ElPagination>
</template>

<script setup lang="ts">
import { ElPagination } from 'element-plus/es'

defineOptions({ name: 'ElPagination' })
</script>
