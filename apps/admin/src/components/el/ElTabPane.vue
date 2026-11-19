<template>
  <ElTabPane v-bind="$attrs" :class="['el_tabpane', $attrs.class as string | undefined]">
    <slot />
  </ElTabPane>
</template>

<script setup lang="ts">
import { ElTabPane } from 'element-plus/es'

defineOptions({ name: 'ElTabPane' })
</script>
