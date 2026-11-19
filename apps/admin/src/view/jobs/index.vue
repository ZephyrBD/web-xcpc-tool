<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue'
import { messageError } from '@/lib/feedback'
import ElTabPane from '@/components/el/ElTabPane.vue'
import ElTabs from '@/components/el/ElTabs.vue'
import { useSse } from '@/composables/useSse'
import { usePrintTasks } from '@/view/jobs/composables/usePrintTasks'
import { useBalloonTasks } from '@/view/jobs/composables/useBalloonTasks'
import PrintTasksPane from '@/view/jobs/components/PrintTasksPane.vue'
import BalloonTasksPane from '@/view/jobs/components/BalloonTasksPane.vue'
import type { BalloonTask, PrintTask } from '@/types'
defineOptions({ name: 'Jobs' })

const activeTab = ref('print')
const print = usePrintTasks()
const balloon = useBalloonTasks()

useSse((event, data) => {
  if (event === 'print-task') {
    const t = data as PrintTask
    if (t?.id && !print.knownPrintIds.has(t.id)) {
      print.knownPrintIds.add(t.id)
      if (print.autoPrint.value && t.status === 'pending') {
        void print.printAndAck(t.id).catch(() => messageError('自动打印没成功，请手动打印'))
      }
    }
  }
  if (event === 'balloon-task') {
    const t = data as BalloonTask
    if (t?.id && !balloon.knownBalloonIds.has(t.id)) {
      balloon.knownBalloonIds.add(t.id)
      if (balloon.autoPrintBalloon.value && t.status === 'pending') {
        void balloon.printAndAck(t).catch(() => messageError('自动打印没成功，请手动打印'))
      }
    }
  }
  if (event === 'print-task') print.scheduleRefresh()
  if (event === 'balloon-task') balloon.scheduleRefresh()
})

onMounted(() => {
  void print.refresh()
  void balloon.refresh()
})
onUnmounted(() => {
  print.dispose()
  balloon.dispose()
})
</script>

<template>
  <div class="jobs page_fill">
    <ElTabs v-model="activeTab" class="jobs_tabs">
      <ElTabPane label="打印任务" name="print">
        <PrintTasksPane :store="print" />
      </ElTabPane>
      <ElTabPane label="气球任务" name="balloon">
        <BalloonTasksPane :store="balloon" />
      </ElTabPane>
    </ElTabs>
  </div>
</template>

<style scoped lang="scss">
.jobs_tabs {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.jobs_tabs :deep(.el-tabs__header) {
  flex-shrink: 0;
}

.jobs_tabs :deep(.el-tabs__content) {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.jobs_tabs :deep(.el-tab-pane) {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
</style>
