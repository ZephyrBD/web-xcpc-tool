<template>
  <ElTabs v-bind="$attrs" :class="['el_tabs', $attrs.class as string | undefined]">
    <slot />
  </ElTabs>
</template>

<script setup lang="ts">
import { ElTabs } from 'element-plus/es'

defineOptions({ name: 'ElTabs' })
</script>
