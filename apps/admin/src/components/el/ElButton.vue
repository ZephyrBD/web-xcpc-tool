<template>
  <ElButton v-bind="$attrs" :class="['el_button', $attrs.class as string | undefined]">
    <slot />
  </ElButton>
</template>

<script setup lang="ts">
import { ElButton } from 'element-plus/es'

defineOptions({ name: 'ElButton' })
</script>
