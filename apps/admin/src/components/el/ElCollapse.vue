<template>
  <ElCollapse v-bind="$attrs" :class="['el_collapse', $attrs.class as string | undefined]">
    <slot />
  </ElCollapse>
</template>

<script setup lang="ts">
import { ElCollapse } from 'element-plus/es'

defineOptions({ name: 'ElCollapse' })
</script>
