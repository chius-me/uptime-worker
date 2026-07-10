// ── UptimeWorker App ─────────────────────────────
// Pure Vanilla JS. No frameworks, no build step.

let apiData = null   // from /api/data
let lastRenderedAt = 0  // track last rendered updatedAt to skip unnecessary re-renders

// ── SVG Icons ────────────────────────────────────
const ICONS = {
  check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>',
  alert: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>',
  triangle: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>',
}

// ── Color ────────────────────────────────────────
function barColor(percent) {
  const p = Number(percent)
  if (p >= 99.9) return '#3bd671'
  if (p >= 99)   return '#9deab8'
  if (p >= 95)   return '#f29030'
  if (isNaN(p))  return '#adb5bd'
  return '#df484a'
}

function hexToRgb(hex) {
  const r = parseInt(hex.slice(1,3), 16)
  const g = parseInt(hex.slice(3,5), 16)
  const b = parseInt(hex.slice(5,7), 16)
  return { r, g, b }
}

// ── Fetch ────────────────────────────────────────
async function fetchStatus() {
  try {
    const resp = await fetch('/api/data')
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
    apiData = await resp.json()
    return true
  } catch (err) {
    console.error('Failed to fetch status:', err)
    apiData = null
    return false
  }
}

function esc(str) {
  if (!str) return ''
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function getCssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim()
}

// ── Router ───────────────────────────────────────
function currentRoute() {
  return window.location.hash.slice(1) || '/'
}

// ── Render: Full Page ────────────────────────────
async function render() {
  if (!apiData) return

  const cfg = apiData.config
  document.getElementById('page-title').textContent = cfg.title || 'UptimeWorker'
  document.querySelector('.nav-brand').innerHTML = cfg.logo
    ? `<img src="${esc(cfg.logo)}" height="32" alt="Logo" style="vertical-align: middle; margin-right: 8px;"><span>${esc(cfg.title || 'UptimeWorker')}</span>`
    : esc(cfg.title || 'UptimeWorker')

  // Nav links
  const nav = document.getElementById('nav-links')
  nav.innerHTML = (cfg.links || []).map(l =>
    `<a href="${esc(l.link)}" class="${l.highlight ? 'highlight' : ''}" target="${l.link.startsWith('http') ? '_blank' : '_self'}">${esc(l.label)}</a>`
  ).join('\n')

  // Footer
  document.getElementById('footer-text').innerHTML = cfg.customFooter || 'Powered by <a href="https://github.com/chius-me/uptime-worker" target="_blank">UptimeWorker</a>. Inspired by <a href="https://github.com/lyc8503/UptimeFlare" target="_blank">UptimeFlare</a> and <a href="https://github.com/louislam/uptime-kuma" target="_blank">Uptime Kuma</a>.'

  const route = currentRoute()
  const main = document.getElementById('main-content')
  if (route === '/incidents') {
    renderIncidents(main)
  } else {
    renderStatusPage(main)
  }

  lastRenderedAt = apiData.updatedAt
}

// ── Status Page ──────────────────────────────────
function renderStatusPage(container) {
  const { up, down, updatedAt, monitors, maintenances, state, monitorsConfig, config } = apiData

  const total = up + down
  let statusText, statusColor = '#059669', iconHtml = ICONS.check
  if (total === 0) {
    statusText = I18N.t('No data yet')
    statusColor = '#adb5bd'
    iconHtml = ICONS.alert
  } else if (up === 0) {
    statusText = I18N.t('All systems not operational')
    statusColor = '#df484a'
    iconHtml = ICONS.alert
  } else if (down === 0) {
    statusText = I18N.t('All systems operational')
  } else {
    statusText = I18N.t('Some systems not operational', { down, total })
    statusColor = '#f29030'
    iconHtml = ICONS.alert
  }

  const now = Date.now()
  const nowSec = Math.round(now / 1000)
  const secondsAgo = updatedAt ? nowSec - updatedAt : 0

  let html = `
    <div class="overall-status">
      <div class="overall-icon" style="color:${statusColor}">${iconHtml}</div>
      <div class="status-title" style="color:${statusColor}">${esc(statusText)}</div>
      <div class="status-subtitle">${I18N.t('Last updated on', {
        date: new Date(updatedAt * 1000).toLocaleString(),
        seconds: secondsAgo
      })}</div>
    </div>
  `

  // Active maintenances
  const nowDate = new Date()
  const activeM = (maintenances || []).filter(m =>
    nowDate >= new Date(m.start) && (!m.end || nowDate <= new Date(m.end))
  )
  const upcomingM = (maintenances || []).filter(m => nowDate < new Date(m.start))

  activeM.forEach(m => { html += renderMaintenance(m, false, config) })
  if (upcomingM.length > 0) {
    html += `<div class="status-subtitle" style="text-align:center;margin-top:8px;cursor:pointer" onclick="UW.toggleUpcoming()">
      ${I18N.t('upcoming maintenance', { count: upcomingM.length })} <span id="upcoming-toggle" style="text-decoration:underline">${I18N.t('Show')}</span>
    </div>
    <div id="upcoming-list" style="display:none">
      ${upcomingM.map(m => renderMaintenance(m, true, config)).join('')}
    </div>`
  }

  // Monitors
  const group = config?.group
  const grouped = group && Object.keys(group).length > 0

  if (grouped) {
    Object.entries(group).forEach(([gName, ids]) => {
      const mons = monitorsConfig.filter(m => ids.includes(m.id))
      const downC = mons.filter(m => monitors[m.id] && !monitors[m.id].up).length
      const gColor = downC === 0 ? '#059669' : downC === mons.length ? '#df484a' : '#f29030'
      html += `<details class="monitor-card" open>
        <summary style="cursor:pointer;font-weight:600;display:flex;justify-content:space-between;align-items:center;padding:4px 0">
          <span>${esc(gName)}</span>
          <span style="color:${gColor}">${mons.length - downC}/${mons.length} ${I18N.t('Operational')}</span>
        </summary>`
      mons.forEach(m => { html += renderMonitor(m, monitors[m.id], state) })
      html += `</details>`
    })
  } else {
    monitorsConfig.forEach(m => {
      html += `<div class="monitor-card">${renderMonitor(m, monitors[m.id], state)}</div>`
    })
  }

  container.innerHTML = html

  // Draw bars and charts after DOM
  requestAnimationFrame(() => {
    monitorsConfig.forEach(m => {
      drawBars(m.id, state)
      if (!m.hideLatencyChart) drawChart(m.id, state)
    })
    // Update uptime % text after bars are drawn
    monitorsConfig.forEach(m => { calcAndSetUptime(m.id, state) })
  })
}

function renderMaintenance(m, upcoming, config) {
  const color = upcoming ? (config?.maintenances?.upcomingColor || 'gray') : (m.color || 'yellow')
  return `
    <div class="maintenance-alert ${color}">
      <div class="maintenance-alert-icon">${ICONS.triangle}</div>
      <div style="flex:1">
        <div class="maintenance-alert-title">${upcoming ? I18N.t('Upcoming') + ' ' : ''}${esc(m.title || I18N.t('Scheduled Maintenance'))}</div>
        <div class="maintenance-alert-body">${esc(m.body)}</div>
        <div class="maintenance-alert-meta">
          ${upcoming ? I18N.t('Scheduled for') : I18N.t('From')}: ${new Date(m.start).toLocaleString()}
          ${m.end ? '<br>' + (upcoming ? I18N.t('Expected end') : I18N.t('To')) + ': ' + new Date(m.end).toLocaleString() : ''}
          ${!m.end ? '<br>' + I18N.t('Until further notice') : ''}
        </div>
      </div>
    </div>`
}

function renderMonitor(mon, monData, state) {
  if (!monData) {
    return `<div class="monitor-header"><div class="monitor-name">${ICONS.check} ${esc(mon.name)}</div><div class="monitor-uptime">${I18N.t('No data available')}</div></div>`
  }

  const isUp = monData.up
  const icon = isUp
    ? `<span style="color:#059669">${ICONS.check}</span>`
    : `<span style="color:#df484a">${ICONS.alert}</span>`

  const nameHtml = mon.statusPageLink
    ? `<a href="${esc(mon.statusPageLink)}" target="_blank" style="color:inherit;display:flex;align-items:center;gap:6px">${icon} ${esc(mon.name)}</a>`
    : `<span style="display:flex;align-items:center;gap:6px">${icon} ${esc(mon.name)}</span>`

  return `
    <div class="monitor-header">
      <div class="monitor-name" title="${esc(mon.tooltip || '')}">${nameHtml}</div>
      <div class="monitor-uptime" id="uptime-${mon.id}"></div>
    </div>
    <div class="uptime-bars" id="bars-${mon.id}"></div>
    ${mon.hideLatencyChart ? '' : `<div class="chart-container" id="chart-wrap-${mon.id}"><canvas id="chart-${mon.id}"></canvas></div>`}
  `
}

// ── Uptime Bars (90 days) ────────────────────────
function drawBars(monId, state) {
  const container = document.getElementById(`bars-${monId}`)
  if (!container) return

  const incidents = state?.incident?.[monId]
  if (!incidents || incidents.length === 0) {
    container.innerHTML = ''
    return
  }

  const now = Math.round(Date.now() / 1000)
  const todayStart = Math.floor(Date.now() / 86400000) * 86400

  function overlap(x1, x2, y1, y2) {
    return Math.max(0, Math.min(x2, y2) - Math.max(x1, y1))
  }

  const bars = []
  for (let i = 89; i >= 0; i--) {
    const dayStart = todayStart - i * 86400
    const dayEnd = dayStart + 86400
    let dayDown = 0

    for (const inc of incidents) {
      dayDown += overlap(dayStart, dayEnd, inc.start[0], inc.end ?? now)
    }

    // Total monitored time in this day (from first incident start)
    const monStart = incidents[0].start[0]
    const dayMonTime = overlap(dayStart, dayEnd, monStart, now)
    const pct = dayMonTime > 0 ? ((dayMonTime - dayDown) / dayMonTime * 100) : NaN

    const bar = document.createElement('div')
    bar.className = 'uptime-bar tooltip'
    bar.style.background = barColor(pct)
    bar.innerHTML = `<span class="tooltip-text">${isNaN(pct) ? I18N.t('No Data') : pct.toPrecision(4) + '%'}<br>${new Date(dayStart * 1000).toLocaleDateString()}</span>`
    container.appendChild(bar)
  }
}

function calcAndSetUptime(monId, state) {
  const el = document.getElementById(`uptime-${monId}`)
  if (!el) return

  const incidents = state?.incident?.[monId]
  if (!incidents || incidents.length === 0) return

  const now = Math.round(Date.now() / 1000)
  const firstStart = incidents[0].start[0]
  let totalDown = 0
  for (const inc of incidents) {
    totalDown += (inc.end ?? now) - inc.start[0]
  }
  const totalTime = now - firstStart
  const pct = totalTime > 0 ? ((totalTime - totalDown) / totalTime * 100).toPrecision(4) : '100.0'
  el.textContent = I18N.t('Overall', { percent: pct })
  el.style.color = barColor(pct)
}

// ── Latency Chart (Canvas) ───────────────────────
function drawChart(monId, state) {
  const canvas = document.getElementById(`chart-${monId}`)
  if (!canvas) return
  const latencies = state?.latency?.[monId]
  if (!latencies || latencies.length < 2) {
    const ctx = canvas.getContext('2d')
    const parent = canvas.parentElement
    canvas.width = (parent.clientWidth || 800) * (window.devicePixelRatio || 1)
    canvas.height = 150 * (window.devicePixelRatio || 1)
    canvas.style.width = (parent.clientWidth || 800) + 'px'
    canvas.style.height = '150px'
    ctx.scale(window.devicePixelRatio || 1, window.devicePixelRatio || 1)
    ctx.fillStyle = getCssVar('--text-muted') || '#909296'
    ctx.font = '14px -apple-system, sans-serif'
    ctx.textAlign = 'center'
    ctx.fillText(I18N.t('No data available'), canvas.width / 2 / (window.devicePixelRatio || 1), 80)
    return
  }

  const parent = canvas.parentElement
  const dpr = window.devicePixelRatio || 1
  const w = parent.clientWidth || 800
  const h = 150
  canvas.width = w * dpr
  canvas.height = h * dpr
  canvas.style.width = w + 'px'
  canvas.style.height = h + 'px'

  const ctx = canvas.getContext('2d')
  ctx.scale(dpr, dpr)

  const pad = { top: 24, bottom: 20, left: 44, right: 16 }
  const plotW = w - pad.left - pad.right
  const plotH = h - pad.top - pad.bottom

  const isDark = document.documentElement.getAttribute('data-theme') === 'dark' ||
    (document.documentElement.getAttribute('data-theme') === 'auto' && window.matchMedia('(prefers-color-scheme: dark)').matches)
  const lineColor = isDark ? '#70778c' : '#112'
  const gridColor = isDark ? '#373a40' : '#e9ecef'
  const textColor = isDark ? '#70778c' : '#868e96'

  // Data range
  const points = latencies.map(l => ({ x: l.time * 1000, y: l.ping }))
  const xMin = points[0].x
  const xMax = points[points.length - 1].x
  const xRange = xMax - xMin || 1
  const yMin = 0
  const yMax = Math.max(...points.map(p => p.y)) * 1.15 || 100

  function toX(x) { return pad.left + (x - xMin) / xRange * plotW }
  function toY(y) { return pad.top + plotH - (y - yMin) / (yMax - yMin) * plotH }

  // Grid lines
  ctx.strokeStyle = gridColor
  ctx.lineWidth = 1
  ctx.font = '11px -apple-system, sans-serif'
  ctx.fillStyle = textColor
  ctx.textAlign = 'right'

  const ySteps = 4
  for (let i = 0; i <= ySteps; i++) {
    const yVal = yMin + (yMax - yMin) * i / ySteps
    const yPos = toY(yVal)
    ctx.beginPath()
    ctx.moveTo(pad.left, yPos)
    ctx.lineTo(w - pad.right, yPos)
    ctx.stroke()
    ctx.fillText(Math.round(yVal) + 'ms', pad.left - 6, yPos + 4)
  }

  // Line
  if (points.length >= 2) {
    ctx.beginPath()
    ctx.strokeStyle = isDark ? '#70778c' : '#909296'
    ctx.lineWidth = 2
    ctx.lineJoin = 'round'
    ctx.moveTo(toX(points[0].x), toY(points[0].y))
    for (let i = 1; i < points.length; i++) {
      ctx.lineTo(toX(points[i].x), toY(points[i].y))
    }
    ctx.stroke()

    // Fill gradient under line
    const gradient = ctx.createLinearGradient(0, pad.top, 0, pad.top + plotH)
    gradient.addColorStop(0, isDark ? 'rgba(112,119,140,0.2)' : 'rgba(144,146,150,0.2)')
    gradient.addColorStop(1, 'rgba(0,0,0,0.01)')
    ctx.lineTo(toX(points[points.length - 1].x), pad.top + plotH)
    ctx.lineTo(toX(points[0].x), pad.top + plotH)
    ctx.closePath()
    ctx.fillStyle = gradient
    ctx.fill()
  }

  // Title
  ctx.fillStyle = textColor
  ctx.font = '12px -apple-system, sans-serif'
  ctx.textAlign = 'left'
  ctx.fillText(I18N.t('Response times'), pad.left, 14)
}

// ── Incidents Page ───────────────────────────────
function renderIncidents(container) {
  const m = apiData?.maintenances || []
  if (m.length === 0) {
    const msg = I18N.t('No incidents')
    container.innerHTML = `<div class="empty-state">${esc(msg)}</div>`
    return
  }
  let html = `<div class="empty-state">${I18N.t('Incidents history')}</div>`
  m.forEach(maintenance => {
    html += renderMaintenance(maintenance, false, apiData.config)
  })
  container.innerHTML = html
}

// ── Expose for inline event handlers ─────────────
window.UW = {
  toggleUpcoming() {
    const list = document.getElementById('upcoming-list')
    const toggle = document.getElementById('upcoming-toggle')
    if (!list || !toggle) return
    const show = list.style.display === 'none'
    list.style.display = show ? 'block' : 'none'
    toggle.textContent = show ? I18N.t('Hide') : I18N.t('Show')
  }
}

// ── Auto-refresh ─────────────────────────────────
let refreshTimer = null
function startAutoRefresh() {
  if (refreshTimer) clearInterval(refreshTimer)
  refreshTimer = setInterval(async () => {
    if (document.hidden) return
    await fetchStatus()
    if (apiData && apiData.updatedAt !== lastRenderedAt) {
      render()
    }
  }, 60000)
}

// ── Resize ────────────────────────────────────────
let resizeTimer = null
window.addEventListener('resize', () => {
  if (resizeTimer) clearTimeout(resizeTimer)
  resizeTimer = setTimeout(() => {
    if (apiData) render()
  }, 250)
});

// ── Theme ────────────────────────────────────────
(function initTheme() {
  const saved = localStorage.getItem('uptime-worker-theme')
  if (saved) document.documentElement.setAttribute('data-theme', saved)
})()

// ── Boot ─────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  await I18N.init()
  const main = document.getElementById('main-content')
  main.innerHTML = '<div class="empty-state"><div class="loading-spinner"></div></div>'
  window.addEventListener('hashchange', () => { if (apiData) render() })
  const ok = await fetchStatus()
  if (ok && apiData) {
    render()
  } else {
    main.innerHTML = `<div class="empty-state">${esc(I18N.t('No data available'))}</div>`
  }
  startAutoRefresh()
})
