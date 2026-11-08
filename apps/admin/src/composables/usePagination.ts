import { computed, ref, watch, type Ref } from 'vue'

/**
 * 客户端分页：列表始终是完整拉取的数据，这里只做视图层切片。
 * 列表刷新（含 SSE 触发）后页码可能越界（条目被处理完），收敛回最后一页。
 */
export function usePagination<T>(list: Ref<T[]>, defaultPageSize = 20) {
  const page = ref(1)
  const pageSize = ref(defaultPageSize)
  const totalPages = computed(() => Math.max(1, Math.ceil(list.value.length / pageSize.value)))
  watch(totalPages, (t) => {
    if (page.value > t) page.value = t
  })
  const paged = computed(() =>
    list.value.slice((page.value - 1) * pageSize.value, page.value * pageSize.value),
  )
  return { page, pageSize, paged, totalPages }
}
