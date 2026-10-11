<script setup lang="ts">
/**
 * CPA Nexus's original chibi catgirl mascot, drawn in SVG with the theme
 * tokens so it follows the palette.
 *   sit  – full body sitting, for empty states
 *   peek – head and paws, peeking over the edge of a card (login)
 *   head – head only, for small spots such as the admin avatar
 * Decorative by default; pass `label` to expose it to screen readers.
 */
const props = withDefaults(defineProps<{ variant?: 'sit' | 'peek' | 'head'; size?: number; label?: string }>(), { variant: 'sit', size: 96 })
const viewBox = computed(() => props.variant === 'sit' ? '18 4 176 222' : props.variant === 'peek' ? '30 4 140 136' : '38 4 124 150')
const height = computed(() => {
  const [, , width, tall] = viewBox.value.split(' ').map(Number)
  return Math.round(props.size * tall! / width!)
})
</script>

<template>
  <svg
    class="catgirl" :class="`catgirl-${variant}`" :viewBox="viewBox" :width="size" :height="height"
    :role="label ? 'img' : undefined" :aria-label="label" :aria-hidden="label ? undefined : 'true'" xmlns="http://www.w3.org/2000/svg"
  >
    <!-- tail -->
    <path v-if="variant === 'sit'" class="cg-tail" d="M138 196 C170 196 186 176 178 150 C174 138 162 136 160 146" fill="none" stroke="var(--cg-hair-dark)" stroke-width="9" stroke-linecap="round" />
    <path v-if="variant === 'sit'" class="cg-tail" d="M164 140 C160 146 159 150 161 154" fill="none" stroke="var(--cg-hair)" stroke-width="9" stroke-linecap="round" />

    <!-- body (sitting) -->
    <g v-if="variant === 'sit'">
      <path d="M84 186 L80 214 Q80 220 87 220 L94 220 Q98 220 98 214 L98 186 Z" fill="var(--cg-stocking)" stroke="var(--cg-line)" stroke-width="1.5" />
      <path d="M102 186 L102 214 Q102 220 106 220 L113 220 Q120 220 120 214 L116 186 Z" fill="var(--cg-stocking)" stroke="var(--cg-line)" stroke-width="1.5" />
      <path d="M80 191 L98 191 M102 191 L119 191" stroke="var(--cg-line)" stroke-width="1.2" />
      <ellipse cx="88" cy="220" rx="11" ry="5" fill="var(--cg-dress-dark)" />
      <ellipse cx="112" cy="220" rx="11" ry="5" fill="var(--cg-dress-dark)" />
      <path d="M76 140 Q100 132 124 140 L140 190 Q100 200 60 190 Z" fill="var(--cg-dress)" />
      <path d="M60 190 Q100 200 140 190 L138 184 Q100 194 62 184 Z" fill="var(--cg-dress-dark)" />
      <path d="M80 140 Q100 152 120 140 L116 136 Q100 144 84 136 Z" fill="#fff" />
      <path d="M76 144 Q64 160 70 176" fill="none" stroke="var(--cg-dress)" stroke-width="12" stroke-linecap="round" />
      <path d="M124 144 Q136 160 130 176" fill="none" stroke="var(--cg-dress)" stroke-width="12" stroke-linecap="round" />
      <circle cx="72" cy="178" r="7" fill="#fff" stroke="var(--cg-line)" stroke-width="1.2" />
      <circle cx="128" cy="178" r="7" fill="#fff" stroke="var(--cg-line)" stroke-width="1.2" />
      <circle cx="100" cy="148" r="5" fill="var(--cg-bell)" stroke="#d9a94b" stroke-width="1" />
      <path d="M97 149 L103 149" stroke="#b9862f" stroke-width="1" />
    </g>

    <!-- head -->
    <g class="cg-head">
      <ellipse cx="100" cy="94" rx="60" ry="56" fill="var(--cg-hair-dark)" />
      <path d="M58 64 L62 12 L92 44 Z" fill="var(--cg-hair)" />
      <path d="M142 64 L138 12 L108 44 Z" fill="var(--cg-hair)" />
      <path class="cg-ear-inner" d="M66 54 L68 26 L84 44 Z" fill="var(--sakura)" opacity=".75" />
      <path class="cg-ear-inner" d="M134 54 L132 26 L116 44 Z" fill="var(--sakura)" opacity=".75" />
      <path d="M46 96 Q44 132 58 146 Q60 120 62 100 Z" fill="var(--cg-hair-dark)" />
      <path d="M154 96 Q156 132 142 146 Q140 120 138 100 Z" fill="var(--cg-hair-dark)" />
      <ellipse cx="100" cy="102" rx="45" ry="40" fill="var(--cg-skin)" />
      <path d="M54 92 Q58 48 100 44 Q142 48 146 92 Q136 74 126 84 Q120 66 108 78 Q100 62 92 78 Q80 66 74 84 Q64 74 54 92 Z" fill="var(--cg-hair)" />
      <path d="M56 92 Q52 112 60 128 Q62 108 66 96 Z" fill="var(--cg-hair)" />
      <path d="M144 92 Q148 112 140 128 Q138 108 134 96 Z" fill="var(--cg-hair)" />
      <g class="cg-eyes">
        <ellipse cx="82" cy="106" rx="9" ry="11" fill="var(--cg-eye)" />
        <ellipse cx="118" cy="106" rx="9" ry="11" fill="var(--cg-eye)" />
        <ellipse cx="82" cy="111" rx="6" ry="5" fill="var(--sakura)" opacity=".55" />
        <ellipse cx="118" cy="111" rx="6" ry="5" fill="var(--sakura)" opacity=".55" />
        <circle cx="85" cy="101" r="3.4" fill="#fff" />
        <circle cx="121" cy="101" r="3.4" fill="#fff" />
        <circle cx="79" cy="110" r="1.6" fill="#fff" />
        <circle cx="115" cy="110" r="1.6" fill="#fff" />
      </g>
      <ellipse cx="68" cy="122" rx="7" ry="4" fill="var(--sakura)" opacity=".4" />
      <ellipse cx="132" cy="122" rx="7" ry="4" fill="var(--sakura)" opacity=".4" />
      <path d="M93 122 Q96.5 126 100 122 Q103.5 126 107 122" fill="none" stroke="var(--cg-mouth)" stroke-width="1.8" stroke-linecap="round" />
      <g transform="translate(136 66)">
        <circle cx="0" cy="-5" r="4" fill="var(--sakura)" /><circle cx="5" cy="-1" r="4" fill="var(--sakura)" /><circle cx="3" cy="5" r="4" fill="var(--sakura)" />
        <circle cx="-3" cy="5" r="4" fill="var(--sakura)" /><circle cx="-5" cy="-1" r="4" fill="var(--sakura)" /><circle cx="0" cy="1" r="2.2" fill="var(--cg-bell)" />
      </g>
    </g>

    <!-- paws over the card edge -->
    <g v-if="variant === 'peek'">
      <ellipse cx="74" cy="138" rx="13" ry="9" fill="#fff" stroke="var(--cg-line)" stroke-width="1.5" />
      <ellipse cx="126" cy="138" rx="13" ry="9" fill="#fff" stroke="var(--cg-line)" stroke-width="1.5" />
      <path d="M70 134 L70 138 M78 134 L78 138 M122 134 L122 138 M130 134 L130 138" stroke="var(--cg-line)" stroke-width="1.2" stroke-linecap="round" />
    </g>
  </svg>
</template>

<style scoped>
.catgirl {
  --cg-hair: #cbbbe9; --cg-hair-dark: #b29fdc; --cg-skin: #fff3ec; --cg-eye: #5a4791; --cg-mouth: #8a5470;
  --cg-dress: #9a86cf; --cg-dress-dark: #7b67b5; --cg-stocking: #fdfcff; --cg-line: #d6cde6; --cg-bell: #f5d27a;
  display: block; overflow: visible; flex-shrink: 0;
}
@media (prefers-reduced-motion: no-preference) {
  .cg-eyes { transform-box: fill-box; transform-origin: center; animation: cg-blink 5.5s infinite; }
  .cg-tail { transform-box: view-box; transform-origin: 138px 196px; animation: cg-tail 3.2s ease-in-out infinite; }
}
@keyframes cg-blink { 0%, 94%, 100% { transform: scaleY(1); } 96% { transform: scaleY(.1); } }
@keyframes cg-tail { 0%, 100% { transform: rotate(0deg); } 50% { transform: rotate(-7deg); } }
</style>
