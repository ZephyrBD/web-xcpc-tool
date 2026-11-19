<template>
  <ElCollapseItem v-bind="$attrs" :class="['el_collapseitem', $attrs.class as string | undefined]">
    <slot />
  </ElCollapseItem>
</template>

<script setup lang="ts">
import { ElCollapseItem } from 'element-plus/es'

defineOptions({ name: 'ElCollapseItem' })
</script>
