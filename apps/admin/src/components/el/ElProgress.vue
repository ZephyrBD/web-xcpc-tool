<template>
  <ElProgress v-bind="$attrs" :class="['el_progress', $attrs.class as string | undefined]">
    <slot />
  </ElProgress>
</template>

<script setup lang="ts">
import { ElProgress } from 'element-plus/es'

defineOptions({ name: 'ElProgress' })
</script>
