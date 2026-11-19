<script setup lang="ts">
import ElButton from '@/components/el/ElButton.vue'
import ElDialog from '@/components/el/ElDialog.vue'
import ElProgress from '@/components/el/ElProgress.vue'
import type { ProvisionStore } from '@/view/auth/composables/useProvision'

defineProps<{ provision: ProvisionStore }>()

defineOptions({ name: 'ProvisionDialog' })
</script>

<template>
  <ElDialog
    v-model="provision.provDialog.value"
    title="一键配置密码"
    width="560px"
    :close-on-click-modal="!provision.provRunning.value"
    :close-on-press-escape="!provision.provRunning.value"
    :show-close="!provision.provRunning.value"
  >
    <ElProgress :percentage="provision.provProgress.value" :status="provision.provStatus.value" />
    <p class="prov_current">
      <template v-if="provision.provRunning.value && provision.provCurrent.value">
        正在配置：{{ provision.provCurrent.value.icpcId }} / {{ provision.provCurrent.value.name }}（第 {{ provision.provResults.value.length + 1 }} / 共 {{ provision.provTargets.value.length }} 支）
      </template>
      <template v-else-if="provision.provCancelled.value">已取消，配置中止</template>
      <template v-else>配置完成</template>
    </p>
    <p class="prov_counters">成功 {{ provision.provOk.value }} · 跳过 {{ provision.provSkip.value }} · 失败 {{ provision.provFail.value }}</p>
    <p v-if="!provision.provRunning.value && provision.provFail.value > 0 && provision.allFailSameReason.value" class="prov_hint">
      如全部失败，请检查 DOMjudge 账号是否具备用户管理(Admin)权限
    </p>
    <div v-if="provision.provResults.value.length" class="prov_list">
      <p v-for="r in provision.provResults.value" :key="r.icpcId" class="prov_line" :class="'prov_' + r.status">
        <span class="prov_mark">{{ r.status === 'ok' ? '✓' : r.status === 'skip' ? '⊘' : '✗' }}</span>
        {{ r.icpcId }} {{ r.name }}<template v-if="r.reason"> — {{ r.reason }}</template>
      </p>
    </div>
    <template #footer>
      <ElButton v-if="provision.provRunning.value" @click="provision.cancelProvision">取消</ElButton>
      <ElButton v-else type="primary" @click="provision.provDialog.value = false">关闭</ElButton>
    </template>
  </ElDialog>
</template>

<style scoped lang="scss">
.prov_current {
  margin: 12px 0 4px;
  font-size: var(--text-15);
}

.prov_counters {
  margin: 0 0 8px;
  font-size: var(--text-13);
  color: var(--text-muted);
}

.prov_hint {
  margin: 0 0 8px;
  font-size: var(--text-13);
  color: var(--brand-orange);
}

.prov_list {
  max-height: 260px;
  overflow-y: auto;
  border-top: 1px solid color-mix(in srgb, var(--text-muted) 20%, transparent);
  padding-top: 8px;
}

.prov_line {
  margin: 0;
  font-size: var(--text-13);
  line-height: 1.8;
  word-break: break-all;
}

.prov_mark {
  display: inline-block;
  width: 1.4em;
  text-align: center;
}

.prov_ok {
  color: var(--brand-green);
}

.prov_skip {
  color: var(--text-muted);
}

.prov_fail {
  color: var(--brand-orange);
}
</style>
