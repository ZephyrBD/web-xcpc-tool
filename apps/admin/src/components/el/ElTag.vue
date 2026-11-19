<template>
  <ElTag v-bind="$attrs" :class="['el_tag', $attrs.class as string | undefined]">
    <slot />
  </ElTag>
</template>

<script setup lang="ts">
import { ElTag } from 'element-plus/es'

defineOptions({ name: 'ElTag' })
</script>
