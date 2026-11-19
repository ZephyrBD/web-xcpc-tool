<template>
  <ElTableColumn v-bind="$attrs" :class="['el_tablecolumn', $attrs.class as string | undefined]">
    <template v-if="$slots.default" #default="scope">
      <!-- EP 列注册时会用假 scope（{ row: {}, $index: -1 }）调一次插槽并收编其
           Fragment 子节点到 hidden-columns，产生不可交互的重复副本；
           body 单元格的真实 scope 里 $index ≥ 0，据此跳过那次渲染。
           注意：type="expand" 的展开插槽拿到的是 row 本体，不兼容此转发。 -->
      <slot v-if="scope && scope.$index !== -1" v-bind="scope" />
    </template>
    <template v-if="$slots.header" #header="scope">
      <slot name="header" v-bind="scope ?? {}" />
    </template>
    <template v-if="$slots.expand" #expand="scope">
      <slot name="expand" v-bind="scope ?? {}" />
    </template>
  </ElTableColumn>
</template>

<script setup lang="ts">
import { ElTableColumn } from 'element-plus/es'

defineOptions({ name: 'ElTableColumn' })
</script>
