// ── UptimeWorker App ─────────────────────────────
// Pure Vanilla JS. No frameworks, no build step.

let apiData = null   // from /api/data
let lastRenderedState = ''  // track status state to skip unnecessary re-renders

// ── SVG Icons ────────────────────────────────────
const ICONS = {
  check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>',
  alert: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>',
  triangle: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>',
}

// ── Color ────────────────────────────────────────
function barColor(percent) {
  const p = Number(percent)
  if (p >= 99.9) return 'var(--green)'
  if (p >= 99)   return 'rgba(16, 185, 129, 0.6)'
  if (p >= 95)   return 'var(--orange)'
  if (isNaN(p))  return 'var(--gray)'
  return 'var(--red)'
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

  lastRenderedState = renderStateKey(apiData)
}

// ── Status Page ──────────────────────────────────
function renderStatusPage(container) {
  container.innerHTML = renderStatusPageHtml(apiData)
  setupUpcomingMaintenanceToggle()

  const { state, monitorsConfig } = apiData

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

function overallStatus(data) {
  if (data.monitoringStatus === 'initializing') {
    return { text: I18N.t('Monitoring initializing'), icon: ICONS.alert, cssClass: 'status-warn' }
  }
  if (data.monitoringStatus === 'delayed') {
    return { text: I18N.t('Monitoring delayed'), icon: ICONS.alert, cssClass: 'status-stale' }
  }
  if (data.down === 0) {
    return { text: I18N.t('All systems operational'), icon: ICONS.check, cssClass: 'status-ok' }
  }
  if (data.up === 0) {
    return { text: I18N.t('All systems not operational'), icon: ICONS.alert, cssClass: 'status-error' }
  }
  return {
    text: I18N.t('Some systems not operational', { down: data.down, total: data.up + data.down }),
    icon: ICONS.alert,
    cssClass: 'status-warn',
  }
}

function monitoringStatusForRender(data, nowSec = Math.round(Date.now() / 1000)) {
  if (!data.updatedAt || data.monitoringStatus === 'initializing') return 'initializing'
  if (data.stale || data.monitoringStatus === 'delayed' || nowSec - data.updatedAt > 180) return 'delayed'
  return 'healthy'
}

function renderStateKey(data) {
  return [data.updatedAt, data.monitoringStatus, data.stale, monitoringStatusForRender(data)].join(':')
}

function renderStatusPageHtml(data) {
  const { updatedAt, monitors, maintenances, state, monitorsConfig, config } = data
  const monitoringStatus = monitoringStatusForRender(data)
  const status = overallStatus({ ...data, monitoringStatus })
  const nowSec = Math.round(Date.now() / 1000)
  const secondsAgo = updatedAt ? Math.max(0, nowSec - updatedAt) : 0
  const lastCheck = updatedAt
    ? `${new Date(updatedAt * 1000).toLocaleString()} (${secondsAgo}s ago)`
    : I18N.t('Unknown')

  let html = `<section class="overall-status ${status.cssClass}">
    <div class="overall-icon">${status.icon}</div>
    <div class="status-title">${status.text}</div>
    <div class="status-subtitle">${I18N.t('Last successful check')}: ${lastCheck}</div>
  </section>`

  // Active maintenances
  const nowDate = new Date()
  const activeM = (maintenances || []).filter(m =>
    nowDate >= new Date(m.start) && (!m.end || nowDate <= new Date(m.end))
  )
  const upcomingM = (maintenances || []).filter(m => nowDate < new Date(m.start))

  activeM.forEach(m => { html += renderMaintenance(m, false, config) })
  if (upcomingM.length > 0) {
    html += `<div class="status-subtitle upcoming-maintenance-toggle">
      ${I18N.t('upcoming maintenance', { count: upcomingM.length })} <button type="button" id="upcoming-toggle">${I18N.t('Show')}</button>
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
      const downC = mons.filter(m => monitors[m.id]?.up === false).length
      const gColor = monitoringStatus !== 'healthy' ? 'var(--gray)' : downC === 0 ? 'var(--green)' : downC === mons.length ? 'var(--red)' : 'var(--orange)'
      const groupStatus = monitoringStatus !== 'healthy'
        ? I18N.t('Unknown')
        : `${mons.length - downC}/${mons.length} ${I18N.t('Operational')}`
      html += `<details class="monitor-card" open>
        <summary style="cursor:pointer;font-weight:600;display:flex;justify-content:space-between;align-items:center;padding:4px 0">
          <span>${esc(gName)}</span>
          <span style="color:${gColor};font-family:var(--font-mono);font-size:0.875rem">${groupStatus}</span>
        </summary>`
      mons.forEach(m => { html += renderMonitor(m, monitoringStatus === 'healthy' ? monitors[m.id] : { ...monitors[m.id], up: null }, state) })
      html += `</details>`
    })
  } else {
    monitorsConfig.forEach(m => {
      html += `<div class="monitor-card">${renderMonitor(m, monitoringStatus === 'healthy' ? monitors[m.id] : { ...monitors[m.id], up: null }, state)}</div>`
    })
  }

  return html
}

function setupUpcomingMaintenanceToggle() {
  const list = document.getElementById('upcoming-list')
  const toggle = document.getElementById('upcoming-toggle')
  if (!list || !toggle) return

  toggle.addEventListener('click', () => {
    const show = list.style.display === 'none'
    list.style.display = show ? 'block' : 'none'
    toggle.textContent = show ? I18N.t('Hide') : I18N.t('Show')
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

function statusIcon(status) {
  const icon = status === 'up' ? ICONS.check : ICONS.alert
  return `<span class="monitor-status-icon ${status}">${icon}</span>`
}

function renderMonitor(mon, monData, state) {
  if (!monData) {
    return `<div class="monitor-header"><div class="monitor-name">${statusIcon('unknown')} ${esc(mon.name)}</div><div class="monitor-uptime">${I18N.t('No data available')}</div></div>`
  }

  const status = monData.up === true ? 'up' : monData.up === false ? 'down' : 'unknown'
  const icon = statusIcon(status)

  const nameHtml = mon.statusPageLink
    ? `<a href="${esc(mon.statusPageLink)}" target="_blank" style="color:inherit;display:flex;align-items:center;gap:8px">${icon} <span>${esc(mon.name)}</span></a>`
    : `<span style="display:flex;align-items:center;gap:8px">${icon} <span>${esc(mon.name)}</span></span>`

  const latencies = state?.latency?.[mon.id] || []
  const responseSummary = chartSummary(mon.name, latencies)

  return `
    <div class="monitor-header">
      <div class="monitor-name" title="${esc(mon.tooltip || '')}">${nameHtml}</div>
      <div class="monitor-uptime" id="uptime-${mon.id}"></div>
    </div>
    <div class="uptime-bars" id="bars-${mon.id}"></div>
    ${mon.hideLatencyChart ? '' : `
      <div class="chart-container" id="chart-wrap-${mon.id}">
        <canvas id="chart-${mon.id}" role="img" tabindex="0" aria-label="${esc(I18N.t('Response times'))}: ${esc(mon.name)}" aria-describedby="chart-summary-${mon.id}"></canvas>
        <p class="sr-only" id="chart-summary-${mon.id}">${esc(responseSummary)}</p>
        <div class="chart-tooltip" id="chart-tooltip-${mon.id}"></div>
      </div>
    `}
  `
}

// ── Uptime Bars (90 days) ────────────────────────
function startOfLocalDaySeconds(date = new Date()) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime() / 1000
}

function incidentStart(incident) {
  return typeof incident?.startedAt === 'number' ? incident.startedAt : incident?.start?.[0]
}

function incidentEnd(incident) {
  return typeof incident?.resolvedAt === 'number' || incident?.resolvedAt === null
    ? incident.resolvedAt
    : incident?.end
}

function isMonitoringDummyIncident(incident) {
  const start = incident?.start
  const error = incident?.error
  return Array.isArray(start) && start.length === 1 &&
    Array.isArray(error) && error.length === 1 && error[0] === 'dummy' &&
    incident.end !== null && incident.end === start[0]
}

function monitoredIncidents(state, monId) {
  return (state?.incident?.[monId] || []).filter(incident =>
    typeof incidentStart(incident) === 'number' && !isMonitoringDummyIncident(incident)
  )
}

function drawBars(monId, state) {
  const container = document.getElementById(`bars-${monId}`)
  if (!container) return

  const incidents = monitoredIncidents(state, monId)
  if (!incidents || incidents.length === 0) {
    container.innerHTML = ''
    return
  }

  const now = Math.round(Date.now() / 1000)
  const today = new Date()

  function overlap(x1, x2, y1, y2) {
    return Math.max(0, Math.min(x2, y2) - Math.max(x1, y1))
  }

  container.innerHTML = '' // Clear existing
  for (let i = 89; i >= 0; i--) {
    const dayStart = startOfLocalDaySeconds(new Date(today.getFullYear(), today.getMonth(), today.getDate() - i))
    const dayEnd = startOfLocalDaySeconds(new Date(today.getFullYear(), today.getMonth(), today.getDate() - i + 1))
    let dayDown = 0

    for (const inc of incidents) {
      dayDown += overlap(dayStart, dayEnd, incidentStart(inc), incidentEnd(inc) ?? now)
    }

    // Total monitored time in this day (from first incident start)
    const monStart = Math.min(...incidents.map(incidentStart))
    const dayMonTime = overlap(dayStart, dayEnd, monStart, now)
    const pct = dayMonTime > 0 ? ((dayMonTime - dayDown) / dayMonTime * 100) : NaN

    const bar = document.createElement('div')
    bar.className = 'uptime-bar tooltip'
    bar.tabIndex = 0
    bar.style.background = barColor(pct)
    bar.innerHTML = `<span class="tooltip-text">${isNaN(pct) ? I18N.t('No Data') : pct.toPrecision(4) + '%'}<br>${new Date(dayStart * 1000).toLocaleDateString()}</span>`
    container.appendChild(bar)
  }
}

function calcAndSetUptime(monId, state) {
  const el = document.getElementById(`uptime-${monId}`)
  if (!el) return

  const incidents = monitoredIncidents(state, monId)
  if (!incidents || incidents.length === 0) return

  const now = Math.round(Date.now() / 1000)
  const firstStart = Math.min(...incidents.map(incidentStart))
  let totalDown = 0
  for (const inc of incidents) {
    totalDown += (incidentEnd(inc) ?? now) - incidentStart(inc)
  }
  const totalTime = now - firstStart
  const pct = totalTime > 0 ? ((totalTime - totalDown) / totalTime * 100).toPrecision(4) : '100.0'
  el.textContent = I18N.t('Overall', { percent: pct })
  el.style.color = barColor(pct)
}

function chartSummary(monitorName, latencies) {
  if (!latencies || latencies.length === 0) {
    return `${I18N.t('Response times')}: ${monitorName}. ${I18N.t('No data available')}`
  }
  const values = latencies.map(sample => sample.ping)
  const latest = values[values.length - 1]
  return `${I18N.t('Response times')}: ${monitorName}. ${I18N.t('Minimum')}: ${Math.min(...values)} ms. ${I18N.t('Maximum')}: ${Math.max(...values)} ms. ${I18N.t('Latest')}: ${latest} ms.`
}

// ── Latency Chart (Canvas with Bezier curves & Mouseover Interactive Tooltips) ──
function drawChart(monId, state, hoverPoint = null) {
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
    ctx.fillStyle = getCssVar('--text-muted') || '#94a3b8'
    ctx.font = '13px Geist, sans-serif'
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
  const gridColor = isDark ? 'rgba(30, 41, 59, 0.6)' : '#e2e8f0'
  const textColor = isDark ? '#64748b' : '#94a3b8'
  // Pale, low-saturation color for chart
  const accentColor = isDark ? '#64748b' : '#cbd5e1'
  const fillGradientStart = isDark ? 'rgba(100, 116, 139, 0.15)' : 'rgba(203, 213, 225, 0.25)'

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
  ctx.font = '10px Geist Mono, monospace'
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
    ctx.fillText(Math.round(yVal) + 'ms', pad.left - 8, yPos + 3)
  }

  // Draw smooth Bezier curve line
  if (points.length >= 2) {
    ctx.beginPath()
    ctx.moveTo(toX(points[0].x), toY(points[0].y))
    for (let i = 0; i < points.length - 1; i++) {
      const x0 = toX(points[i].x)
      const y0 = toY(points[i].y)
      const x1 = toX(points[i+1].x)
      const y1 = toY(points[i+1].y)
      ctx.bezierCurveTo(x0 + (x1 - x0) / 2, y0, x0 + (x1 - x0) / 2, y1, x1, y1)
    }
    ctx.strokeStyle = accentColor
    ctx.lineWidth = 2
    ctx.lineJoin = 'round'
    ctx.stroke()

    // Closed Area Gradient fill
    ctx.beginPath()
    ctx.moveTo(toX(points[0].x), toY(points[0].y))
    for (let i = 0; i < points.length - 1; i++) {
      const x0 = toX(points[i].x)
      const y0 = toY(points[i].y)
      const x1 = toX(points[i+1].x)
      const y1 = toY(points[i+1].y)
      ctx.bezierCurveTo(x0 + (x1 - x0) / 2, y0, x0 + (x1 - x0) / 2, y1, x1, y1)
    }
    ctx.lineTo(toX(points[points.length - 1].x), pad.top + plotH)
    ctx.lineTo(toX(points[0].x), pad.top + plotH)
    ctx.closePath()

    const gradient = ctx.createLinearGradient(0, pad.top, 0, pad.top + plotH)
    gradient.addColorStop(0, fillGradientStart)
    gradient.addColorStop(1, 'rgba(0, 0, 0, 0.01)')
    ctx.fillStyle = gradient
    ctx.fill()
  }

  // Title
  ctx.fillStyle = isDark ? '#cbd5e1' : '#475569'
  ctx.font = '600 11px Geist, sans-serif'
  ctx.textAlign = 'left'
  ctx.fillText(I18N.t('Response times'), pad.left, 14)

  // Hover Overlay elements
  if (hoverPoint) {
    const hx = toX(hoverPoint.x)
    const hy = toY(hoverPoint.y)

    // Vertical dashed guideline
    ctx.beginPath()
    ctx.setLineDash([3, 3])
    ctx.strokeStyle = isDark ? 'rgba(255, 255, 255, 0.25)' : 'rgba(15, 23, 42, 0.15)'
    ctx.lineWidth = 1
    ctx.moveTo(hx, pad.top)
    ctx.lineTo(hx, pad.top + plotH)
    ctx.stroke()
    ctx.setLineDash([])

    // Glowing outer circle
    ctx.beginPath()
    ctx.arc(hx, hy, 5.5, 0, 2 * Math.PI)
    ctx.fillStyle = isDark ? 'rgba(100, 116, 139, 0.3)' : 'rgba(203, 213, 225, 0.4)'
    ctx.fill()

    // Solid inner dot
    ctx.beginPath()
    ctx.arc(hx, hy, 3.5, 0, 2 * Math.PI)
    ctx.fillStyle = accentColor
    ctx.strokeStyle = isDark ? '#090d16' : '#ffffff'
    ctx.lineWidth = 1.5
    ctx.fill()
    ctx.stroke()
  }

  // Setup event listeners once
  if (!canvas.dataset.listenerAttached) {
    canvas.dataset.listenerAttached = 'true'

    const handleMove = (e) => {
      if (!apiData) return
      const latencies = apiData.state?.latency?.[monId]
      if (!latencies || latencies.length < 2) return

      const rect = canvas.getBoundingClientRect()
      const mouseX = e.clientX - rect.left

      const pad = { top: 24, bottom: 20, left: 44, right: 16 }
      const plotW = rect.width - pad.left - pad.right

      const points = latencies.map(l => ({ x: l.time * 1000, y: l.ping }))
      const xMin = points[0].x
      const xMax = points[points.length - 1].x
      const xRange = xMax - xMin || 1

      function toX(x) { return pad.left + (x - xMin) / xRange * plotW }

      // Find closest data point
      let closest = points[0]
      let minXDist = Math.abs(toX(closest.x) - mouseX)
      for (let i = 1; i < points.length; i++) {
        const xPos = toX(points[i].x)
        const dist = Math.abs(xPos - mouseX)
        if (dist < minXDist) {
          closest = points[i]
          minXDist = dist
        }
      }

      // Redraw canvas with hover dot and dashed line
      drawChart(monId, apiData.state, closest)

      // Render and position floating HTML tooltip
      const tooltip = document.getElementById(`chart-tooltip-${monId}`)
      if (tooltip) {
        const yMin = 0
        const yMax = Math.max(...points.map(p => p.y)) * 1.15 || 100
        const plotH = rect.height - pad.top - pad.bottom
        function toY(y) { return pad.top + plotH - (y - yMin) / (yMax - yMin) * plotH }

        const tx = toX(closest.x)
        const ty = toY(closest.y)

        tooltip.innerHTML = `
          <div class="tooltip-time">${new Date(closest.x).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</div>
          <div class="tooltip-value">${Math.round(closest.y)} ms</div>
        `
        tooltip.style.left = `${tx}px`
        tooltip.style.top = `${ty - 40}px`
        tooltip.style.opacity = '1'
        tooltip.style.visibility = 'visible'
      }
    }

    const handleLeave = () => {
      if (!apiData) return
      drawChart(monId, apiData.state, null)
      const tooltip = document.getElementById(`chart-tooltip-${monId}`)
      if (tooltip) {
        tooltip.style.opacity = '0'
        tooltip.style.visibility = 'hidden'
      }
    }

    canvas.addEventListener('mousemove', handleMove)
    canvas.addEventListener('mouseleave', handleLeave)
  }
}

// ── Incidents Page ──────────────────────────────
function publicIncidentMessage(incident) {
  const changes = incident?.changes
  if (Array.isArray(changes) && changes.length > 0) {
    return changes[changes.length - 1]?.publicMessage || I18N.t('Unknown')
  }
  if (Array.isArray(incident?.error) && incident.error.length > 0) {
    return incident.error[incident.error.length - 1]
  }
  return I18N.t('Unknown')
}

function buildIncidentTimeline(state, monitorsConfig, nowSeconds = Math.round(Date.now() / 1000)) {
  const monitorsById = new Map((monitorsConfig || []).map(monitor => [monitor.id, monitor]))
  const incidentsByMonitor = state?.incident || {}
  const incidents = []

  Object.entries(incidentsByMonitor).forEach(([monitorId, monitorIncidents]) => {
    const monitor = monitorsById.get(monitorId)
    if (!monitor || !Array.isArray(monitorIncidents)) return

    monitorIncidents.forEach(incident => {
      const startedAt = incidentStart(incident)
      if (typeof startedAt !== 'number' || isMonitoringDummyIncident(incident)) return
      const resolvedAt = incidentEnd(incident) ?? null
      incidents.push({
        id: incident.id || `${monitorId}:${startedAt}`,
        monitorId,
        monitorName: monitor.name,
        startedAt,
        resolvedAt,
        ongoing: resolvedAt === null,
        durationSeconds: Math.max(0, (resolvedAt ?? nowSeconds) - startedAt),
        publicMessage: publicIncidentMessage(incident),
      })
    })
  })

  return incidents.sort((left, right) => right.startedAt - left.startedAt)
}

function formatIncidentDuration(durationSeconds) {
  const minutes = Math.floor(durationSeconds / 60)
  const seconds = durationSeconds % 60
  if (minutes < 1) return `${seconds}s`
  const hours = Math.floor(minutes / 60)
  return hours > 0 ? `${hours}h ${minutes % 60}m` : `${minutes}m ${seconds}s`
}

function renderIncident(incident) {
  const status = incident.ongoing ? I18N.t('Ongoing') : I18N.t('Resolved')
  return `<article class="incident-card">
    <div class="incident-heading">
      <h2>${esc(incident.monitorName)}</h2>
      <span class="incident-status ${incident.ongoing ? 'ongoing' : 'resolved'}">${esc(status)}</span>
    </div>
    <dl class="incident-details">
      <div><dt>${esc(I18N.t('Affected service'))}</dt><dd>${esc(incident.monitorName)}</dd></div>
      <div><dt>${esc(I18N.t('Error category'))}</dt><dd>${esc(incident.publicMessage)}</dd></div>
      <div><dt>${esc(I18N.t('Duration'))}</dt><dd>${esc(formatIncidentDuration(incident.durationSeconds))}</dd></div>
      <div><dt>${esc(I18N.t('From'))}</dt><dd>${new Date(incident.startedAt * 1000).toLocaleString()}</dd></div>
      ${incident.resolvedAt === null ? '' : `<div><dt>${esc(I18N.t('To'))}</dt><dd>${new Date(incident.resolvedAt * 1000).toLocaleString()}</dd></div>`}
    </dl>
  </article>`
}

function renderIncidents(container) {
  const incidents = buildIncidentTimeline(apiData?.state, apiData?.monitorsConfig)
  const maintenances = apiData?.maintenances || []
  let html = `<section class="incidents-section" aria-labelledby="incident-history-title">
    <h1 id="incident-history-title">${esc(I18N.t('Incident history'))}</h1>
    ${incidents.length > 0 ? incidents.map(renderIncident).join('') : `<div class="empty-state">${esc(I18N.t('No incidents'))}</div>`}
  </section>`
  if (maintenances.length > 0) {
    html += `<section class="incidents-section maintenance-history" aria-labelledby="scheduled-maintenance-title">
      <h2 id="scheduled-maintenance-title">${esc(I18N.t('Scheduled maintenance'))}</h2>
      ${maintenances.map(maintenance => renderMaintenance(maintenance, false, apiData.config)).join('')}
    </section>`
  }
  container.innerHTML = html
}

// ── Theme Switcher Manual Toggle logic ───────────
function setupThemeToggle() {
  const btn = document.getElementById('theme-toggle')
  if (!btn) return

  btn.addEventListener('click', () => {
    const current = document.documentElement.getAttribute('data-theme') || 'auto'
    let next = 'light'

    if (current === 'auto') {
      const isSystemDark = window.matchMedia('(prefers-color-scheme: dark)').matches
      next = isSystemDark ? 'light' : 'dark'
    } else {
      next = current === 'dark' ? 'light' : 'dark'
    }

    document.documentElement.setAttribute('data-theme', next)
    localStorage.setItem('uptime-worker-theme', next)
    
    // Redraw charts to update grid/axis colors to match the theme immediately
    if (apiData) render()
  })
}

// ── Auto-refresh ─────────────────────────────────
let refreshTimer = null
function startAutoRefresh() {
  if (refreshTimer) clearInterval(refreshTimer)
  refreshTimer = setInterval(async () => {
    if (document.hidden) return
    await fetchStatus()
    if (apiData && renderStateKey(apiData) !== lastRenderedState) {
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
  setupThemeToggle()
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
