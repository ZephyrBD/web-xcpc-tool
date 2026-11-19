<template>
  <ElSwitch v-bind="$attrs" :class="['el_switch', $attrs.class as string | undefined]">
    <slot />
  </ElSwitch>
</template>

<script setup lang="ts">
import { ElSwitch } from 'element-plus/es'

defineOptions({ name: 'ElSwitch' })
</script>
