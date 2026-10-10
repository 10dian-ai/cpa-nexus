/**
 * Only the Phosphor collection is bundled (`icon.serverBundle` in
 * nuxt.config) and the Iconify API fallback is disabled, so every icon that
 * Nuxt UI renders internally must be mapped to a Phosphor name here. Any key
 * left on Nuxt UI's Lucide default renders as an empty box wherever a Nuxt UI
 * component draws it (toasts today, and any component added later).
 * `tests/ui-icons.test.ts` keeps this map complete for the installed version.
 */
export const NUXT_UI_ICONS = {
  arrowDown: 'i-ph-arrow-down-bold', arrowLeft: 'i-ph-arrow-left-bold', arrowRight: 'i-ph-arrow-right-bold', arrowUp: 'i-ph-arrow-up-bold',
  caution: 'i-ph-warning-circle-bold', check: 'i-ph-check-bold',
  chevronDoubleLeft: 'i-ph-caret-double-left-bold', chevronDoubleRight: 'i-ph-caret-double-right-bold',
  chevronDown: 'i-ph-caret-down-bold', chevronLeft: 'i-ph-caret-left-bold', chevronRight: 'i-ph-caret-right-bold', chevronUp: 'i-ph-caret-up-bold',
  close: 'i-ph-x-bold', copy: 'i-ph-copy-bold', copyCheck: 'i-ph-check-square-offset-bold',
  dark: 'i-ph-moon-bold', drag: 'i-ph-dots-six-vertical-bold', ellipsis: 'i-ph-dots-three-bold',
  error: 'i-ph-x-circle-bold', external: 'i-ph-arrow-up-right-bold', eye: 'i-ph-eye-bold', eyeOff: 'i-ph-eye-slash-bold',
  file: 'i-ph-file-bold', folder: 'i-ph-folder-bold', folderOpen: 'i-ph-folder-open-bold', hash: 'i-ph-hash-bold',
  info: 'i-ph-info-bold', light: 'i-ph-sun-bold', loading: 'i-ph-circle-notch-bold', menu: 'i-ph-list-bold', minus: 'i-ph-minus-bold',
  panelClose: 'i-ph-sidebar-simple-bold', panelOpen: 'i-ph-sidebar-simple-bold', plus: 'i-ph-plus-bold', reload: 'i-ph-arrow-counter-clockwise-bold',
  search: 'i-ph-magnifying-glass-bold', stop: 'i-ph-square-bold', star: 'i-ph-star-bold', success: 'i-ph-check-circle-bold',
  system: 'i-ph-monitor-bold', tip: 'i-ph-lightbulb-bold', upload: 'i-ph-upload-simple-bold', warning: 'i-ph-warning-bold',
} as const
