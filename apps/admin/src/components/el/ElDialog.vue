<template>
  <ElDialog v-bind="$attrs" :class="['el_dialog', $attrs.class as string | undefined]">
    <template v-for="(_, name) in $slots" #[name]="scope">
      <slot :name="name" v-bind="scope ?? {}" />
    </template>
  </ElDialog>
</template>

<script setup lang="ts">
import { ElDialog } from 'element-plus'

defineOptions({ name: 'ElDialog' })
</script>
