<template>
  <ElInput v-bind="$attrs" :class="['el_input', $attrs.class as string | undefined]">
    <slot />
  </ElInput>
</template>

<script setup lang="ts">
import { ElInput } from 'element-plus/es'

defineOptions({ name: 'ElInput' })
</script>
