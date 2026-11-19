<template>
  <ElTable v-bind="$attrs" :class="['el_table', $attrs.class as string | undefined]">
    <slot />
  </ElTable>
</template>

<script setup lang="ts">
import { ElTable } from 'element-plus/es'

defineOptions({ name: 'ElTable' })
</script>
