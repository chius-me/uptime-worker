// ── UptimeWorker i18n ────────────────────────────
// Pure JS, no framework. Loads locale JSON from /locales/{lang}/common.json

const I18N = {
  lang: 'en',
  strings: {},

  normalize(lang) {
    const lower = String(lang || '').trim().replace(/_/g, '-').toLowerCase()
    const base = lower.split('-')[0]
    if (base === 'zh') {
      if (lower.includes('hant') || lower.endsWith('-tw') || lower.endsWith('-hk') || lower.endsWith('-mo')) return 'zh-TW'
      return 'zh-CN'
    }
    if (base === 'fr') return 'fr-FR'
    if (base === 'de') return 'de-DE'
    if (base === 'en') return 'en'
    return 'en'
  },

  // Detect browser language
  detect() {
    const langs = navigator.languages || [navigator.language || 'en']
    for (const l of langs) {
      const lower = String(l).replace(/_/g, '-').toLowerCase()
      const base = lower.split('-')[0]
      if (base === 'zh' || base === 'fr' || base === 'de' || base === 'en') return this.normalize(lower)
    }
    return 'en'
  },

  readSaved() {
    try {
      return localStorage.getItem('uptime-worker-lang')
    } catch {
      return null
    }
  },

  // Load locale data asynchronously. An explicit lang wins over the saved choice.
  async init(lang) {
    const chosen = lang || this.readSaved() || this.detect()
    this.lang = this.normalize(chosen)
    try {
      const resp = await fetch(`/locales/${this.lang}/common.json`)
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
      this.strings = await resp.json()
    } catch {
      // Fallback to English
      if (this.lang !== 'en') {
        try {
          const resp = await fetch('/locales/en/common.json')
          if (resp.ok) this.strings = await resp.json()
        } catch {
          // Keep the last successfully loaded strings.
        }
      }
    }
    document.documentElement.lang = this.lang
  },

  async use(lang) {
    const next = this.normalize(lang)
    try {
      localStorage.setItem('uptime-worker-lang', next)
    } catch {
      // Private browsing can reject storage; the page still switches for this visit.
    }
    await this.init(next)
  },

  // Translate: t('key') or t('key', { var: 'value' })
  t(key, vars) {
    let lookupKey = key
    // Basic plural support: if vars.count > 1, try key_plural first
    if (vars && typeof vars.count === 'number' && vars.count !== 1) {
      const pluralKey = key + '_plural'
      if (this.strings[pluralKey]) lookupKey = pluralKey
    }
    let s = this.strings[lookupKey] || this.strings[key] || key
    if (vars) {
      for (const [k, v] of Object.entries(vars)) {
        s = s.replace(new RegExp(`\\{\\{${k}\\}\\}`, 'g'), String(v))
      }
    }
    return s
  }
}

window.I18N = I18N
