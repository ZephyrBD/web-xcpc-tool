<template>
  <ElEmpty v-bind="$attrs" :class="['el_empty', $attrs.class as string | undefined]">
    <slot />
  </ElEmpty>
</template>

<script setup lang="ts">
import { ElEmpty } from 'element-plus/es'

defineOptions({ name: 'ElEmpty' })
</script>
