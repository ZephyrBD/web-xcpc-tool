<script setup lang="ts">
interface StatCard {
  label: string
  value: string | number | null
  accent: string
  to: string
}

defineProps<{ cards: StatCard[] }>()

defineOptions({ name: 'StatCards' })
</script>

<template>
  <div class="dash_grid">
    <RouterLink
      v-for="card in cards"
      :key="card.label"
      :to="card.to"
      class="stat_card"
      :style="{ '--card-accent': card.accent }"
    >
      <span class="stat_dot" aria-hidden="true"></span>
      <span class="stat_value">{{ card.value ?? '—' }}</span>
      <span class="stat_label">{{ card.label }}</span>
    </RouterLink>
  </div>
</template>

<style scoped lang="scss">
.dash_grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 20px;
  flex-shrink: 0;
}

.stat_card {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 24px;
  border: 1px solid var(--border);
  border-top: 3px solid var(--card-accent);
  border-radius: var(--radius-card);
  background: var(--bg);
  text-decoration: none;
  color: inherit;
  transition: box-shadow 0.15s ease;
}

.stat_card:hover {
  box-shadow: var(--shadow-card);
}

.stat_dot {
  width: 10px;
  height: 10px;
  border-radius: var(--radius-pill);
  background: var(--card-accent);
}

.stat_value {
  font-family: var(--font-heading);
  font-size: var(--text-44);
  font-weight: 600;
  letter-spacing: -0.02em;
  line-height: 1.1;
}

.stat_label {
  font-size: var(--text-15);
  color: var(--text-muted);
}

@media (max-width: 768px) {
  .dash_grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
</style>
