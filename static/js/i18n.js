// ── UptimeWorker i18n ────────────────────────────
// Pure JS, no framework. Loads English locale JSON from /locales/en/common.json

const I18N = {
  lang: 'en',
  strings: {},

  // Load English locale data asynchronously.
  async init() {
    this.lang = 'en'
    try {
      const resp = await fetch('/locales/en/common.json')
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
      this.strings = await resp.json()
    } catch {
      // Keep the last successfully loaded strings.
    }
    document.documentElement.lang = 'en'
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
