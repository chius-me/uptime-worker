// ── UptimeWorker i18n ────────────────────────────
// Pure JS, no framework. Loads locale JSON from /locales/{lang}/common.json

const I18N = {
  lang: 'en',
  strings: {},

  // Detect browser language
  detect() {
    const langs = navigator.languages || [navigator.language || 'en']
    for (const l of langs) {
      const norm = l.replace('_', '-')
      if (norm === 'zh-CN' || norm === 'zh-TW' || norm === 'zh' ||
          norm === 'fr-FR' || norm === 'fr' || norm === 'de-DE' || norm === 'de' ||
          norm === 'en') return norm
    }
    return 'en'
  },

  // Load locale data asynchronously
  async init(lang) {
    this.lang = lang || this.detect()
    // Normalize: zh → zh-CN, fr → fr-FR, de → de-DE
    const map = { zh: 'zh-CN', fr: 'fr-FR', de: 'de-DE' }
    const file = map[this.lang] || this.lang
    try {
      const resp = await fetch(`/locales/${file}/common.json`)
      this.strings = await resp.json()
    } catch {
      // Fallback to English
      if (this.lang !== 'en') {
        const resp = await fetch('/locales/en/common.json')
        this.strings = await resp.json()
      }
    }
    document.documentElement.lang = this.lang
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
