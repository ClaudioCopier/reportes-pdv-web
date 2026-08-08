// Gráficos SVG minimalistas, sin dependencias externas (consistente con el
// resto del sitio: Vite + JS plano). Rediseño visual (V2, 2026-08-02) sobre
// la base de renderBarChart/renderLineChart originales -- mismo motor de
// ejes/tooltips/decimado, look más suave (barras más anchas, radio 6px,
// tooltip oscuro). Mantiene accesibilidad por teclado (tabindex/aria-label/
// focus-blur) que la primera pasada de rediseño había perdido.
const NS = 'http://www.w3.org/2000/svg'

function svgEl(tag, attrs = {}) {
  const e = document.createElementNS(NS, tag)
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v)
  return e
}

function elEmpty(msg) {
  const d = document.createElement('div')
  d.className = 'empty'
  d.textContent = msg
  return d
}

function fechaLabel(diaStr) {
  const d = new Date(diaStr + 'T00:00:00')
  return d.toLocaleDateString('es-CL', { day: '2-digit', month: '2-digit' })
}

function fechaLabelLarga(diaStr) {
  const d = new Date(diaStr + 'T00:00:00')
  return d.toLocaleDateString('es-CL', { weekday: 'short', day: '2-digit', month: 'short' })
}

// Paso "limpio" para las gridlines del eje Y (1/2/5 * 10^n), para no mostrar
// números como "$14.283" en los ticks.
function niceTicks(maxVal, targetTicks = 4) {
  if (maxVal <= 0) return { ticks: [0, 1], top: 1 }
  const rough = maxVal / targetTicks
  const mag = Math.pow(10, Math.floor(Math.log10(rough)))
  const norm = rough / mag
  const step = (norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10) * mag
  const top = Math.ceil(maxVal / step) * step
  const ticks = []
  for (let v = 0; v <= top + 1e-9; v += step) ticks.push(Math.round(v))
  return { ticks, top: top || 1 }
}

// Elige cada N-ésima etiqueta del eje X para que nunca se superpongan,
// siempre incluyendo la primera y la última.
function decimatedIndices(n, plotWidth, minLabelWidth = 46) {
  if (n <= 1) return [0]
  const maxLabels = Math.max(2, Math.floor(plotWidth / minLabelWidth))
  const step = Math.max(1, Math.ceil(n / maxLabels))
  const idxs = []
  for (let i = 0; i < n; i += step) idxs.push(i)
  if (idxs[idxs.length - 1] !== n - 1) idxs.push(n - 1)
  return idxs
}

// Path de una barra con esquinas superiores redondeadas y base cuadrada.
function roundedTopBarPath(x, y, w, h, r) {
  const rr = Math.max(0, Math.min(r, w / 2, h))
  if (rr === 0) return `M${x},${y + h} L${x},${y} L${x + w},${y} L${x + w},${y + h} Z`
  return `M${x},${y + h} L${x},${y + rr} Q${x},${y} ${x + rr},${y} L${x + w - rr},${y} Q${x + w},${y} ${x + w},${y + rr} L${x + w},${y + h} Z`
}

// Tooltip HTML posicionado sobre el SVG.
function makeTooltip(wrap, svg, W, H) {
  const tip = document.createElement('div')
  tip.className = 'chart-tooltip'
  tip.style.display = 'none'
  wrap.appendChild(tip)
  return {
    show(rows, svgX, svgY) {
      tip.textContent = ''
      rows.forEach(([label, value, esTitulo]) => {
        const row = document.createElement('div')
        if (esTitulo) {
          row.className = 'chart-tooltip-title'
          row.textContent = label
        } else {
          row.className = 'chart-tooltip-row'
          const l = document.createElement('span')
          l.className = 'chart-tooltip-label'
          l.textContent = label
          const v = document.createElement('span')
          v.className = 'chart-tooltip-value'
          v.textContent = value
          row.append(l, v)
        }
        tip.appendChild(row)
      })
      tip.style.display = 'block'

      const svgRect = svg.getBoundingClientRect()
      const wrapRect = wrap.getBoundingClientRect()
      const scaleX = svgRect.width / W
      const scaleY = svgRect.height / H
      const x = (svgRect.left - wrapRect.left) + svgX * scaleX
      const y = (svgRect.top - wrapRect.top) + svgY * scaleY

      const tipRect = tip.getBoundingClientRect()
      let left = x - tipRect.width / 2
      left = Math.max(4, Math.min(left, wrapRect.width - tipRect.width - 4))
      let top = y - tipRect.height - 12
      if (top < 4) top = y + 12
      tip.style.left = left + 'px'
      tip.style.top = top + 'px'
    },
    hide() { tip.style.display = 'none' },
  }
}

function ejes(svg, { margin, width, height, plotW, plotH, ticks, top, money }) {
  const y = (v) => margin.top + plotH - (v / top) * plotH
  ticks.forEach((t) => {
    const yy = y(t)
    svg.appendChild(svgEl('line', { x1: margin.left, x2: width - margin.right, y1: yy, y2: yy, class: 'chart-grid' }))
    const label = svgEl('text', { x: margin.left - 12, y: yy + 4, class: 'chart-axis-label', 'text-anchor': 'end' })
    label.textContent = money(t)
    svg.appendChild(label)
  })
  svg.appendChild(svgEl('line', {
    x1: margin.left, x2: width - margin.right,
    y1: margin.top + plotH, y2: margin.top + plotH, class: 'chart-axis-line',
  }))
  return y
}

// ---------------------------------------------------------------------------
// Gráfico de barras -- "Ventas por día".
// ---------------------------------------------------------------------------
export function renderBarChart(container, dias, { money, num }) {
  container.innerHTML = ''
  if (!dias || !dias.length) { container.appendChild(elEmpty('Sin datos en este periodo.')); return }

  const wrap = document.createElement('div')
  wrap.className = 'chart-wrap'
  container.appendChild(wrap)

  const width = Math.max(320, wrap.clientWidth || container.clientWidth || 600)
  const height = 280
  const margin = { top: 16, right: 12, bottom: 34, left: 70 }
  const plotW = width - margin.left - margin.right
  const plotH = height - margin.top - margin.bottom

  const maxVal = Math.max(...dias.map((d) => d.total), 1)
  const { ticks, top } = niceTicks(maxVal)

  const svg = svgEl('svg', { viewBox: `0 0 ${width} ${height}`, preserveAspectRatio: 'xMinYMin meet', role: 'img', 'aria-label': 'Ventas por día' })
  const y = ejes(svg, { margin, width, height, plotW, plotH, ticks, top, money })

  const n = dias.length
  const bandW = plotW / n
  const barW = Math.max(4, Math.min(32, bandW - 4))

  const barsGroup = svgEl('g')
  dias.forEach((d, i) => {
    const cx = margin.left + bandW * i + bandW / 2
    const barH = Math.max(2, (d.total / top) * plotH)
    const barY = margin.top + plotH - barH
    const path = svgEl('path', {
      d: roundedTopBarPath(cx - barW / 2, barY, barW, barH, 6),
      class: 'chart-bar', tabindex: '0', role: 'img',
      'aria-label': `${fechaLabelLarga(d.dia)}: ${money(d.total)}`,
    })
    barsGroup.appendChild(path)
  })
  svg.appendChild(barsGroup)

  decimatedIndices(n, plotW).forEach((i) => {
    const cx = margin.left + bandW * i + bandW / 2
    const label = svgEl('text', { x: cx, y: height - margin.bottom + 20, class: 'chart-axis-label', 'text-anchor': 'middle' })
    label.textContent = fechaLabel(dias[i].dia)
    svg.appendChild(label)
  })

  wrap.appendChild(svg)
  const tooltip = makeTooltip(wrap, svg, width, height)

  barsGroup.querySelectorAll('path').forEach((bar, i) => {
    const d = dias[i]
    const cx = margin.left + bandW * i + bandW / 2
    const barH = Math.max(2, (d.total / top) * plotH)
    const barY = margin.top + plotH - barH
    const mostrar = () => {
      bar.classList.add('chart-bar-hover')
      tooltip.show([
        [fechaLabelLarga(d.dia), '', true],
        ['Total', money(d.total)],
        ['Costo', money(d.costo)],
        ['Ganancia', money(d.gananciaBruta)],
        ['Tickets', num(d.tickets)],
      ], cx, barY)
    }
    const ocultar = () => { bar.classList.remove('chart-bar-hover'); tooltip.hide() }
    bar.addEventListener('pointerenter', mostrar)
    bar.addEventListener('pointermove', mostrar)
    bar.addEventListener('pointerleave', ocultar)
    bar.addEventListener('focus', mostrar)
    bar.addEventListener('blur', ocultar)
  })
}

// ---------------------------------------------------------------------------
// Gráfico de línea -- "Tendencia histórica".
// ---------------------------------------------------------------------------
export function renderLineChart(container, filas, { money, num }) {
  container.innerHTML = ''
  if (!filas || !filas.length) { container.appendChild(elEmpty('Todavía no hay suficiente histórico guardado.')); return }

  const wrap = document.createElement('div')
  wrap.className = 'chart-wrap'
  container.appendChild(wrap)

  const width = Math.max(320, wrap.clientWidth || container.clientWidth || 600)
  const height = 280
  const margin = { top: 16, right: 16, bottom: 34, left: 70 }
  const plotW = width - margin.left - margin.right
  const plotH = height - margin.top - margin.bottom

  const valores = filas.map((f) => (f.resumen || {}).total || 0)
  const maxVal = Math.max(...valores, 1)
  const { ticks, top } = niceTicks(maxVal)

  const svg = svgEl('svg', { viewBox: `0 0 ${width} ${height}`, preserveAspectRatio: 'xMinYMin meet', role: 'img', 'aria-label': 'Tendencia histórica de ventas' })
  const y = ejes(svg, { margin, width, height, plotW, plotH, ticks, top, money })

  const n = filas.length
  const x = (i) => margin.left + (n === 1 ? plotW / 2 : (plotW * i) / (n - 1))

  const points = valores.map((v, i) => [x(i), y(v)])
  const linePath = points.map((p, i) => (i === 0 ? 'M' : 'L') + p[0].toFixed(1) + ',' + p[1].toFixed(1)).join(' ')
  const areaPath = `${linePath} L${points[n - 1][0].toFixed(1)},${(margin.top + plotH).toFixed(1)} L${points[0][0].toFixed(1)},${(margin.top + plotH).toFixed(1)} Z`

  svg.appendChild(svgEl('path', { d: areaPath, class: 'chart-area' }))
  svg.appendChild(svgEl('path', { d: linePath, class: 'chart-line', fill: 'none' }))

  decimatedIndices(n, plotW).forEach((i) => {
    const label = svgEl('text', { x: x(i), y: height - margin.bottom + 20, class: 'chart-axis-label', 'text-anchor': 'middle' })
    label.textContent = fechaLabel(filas[i].fecha)
    svg.appendChild(label)
  })

  const crosshair = svgEl('line', { y1: margin.top, y2: margin.top + plotH, class: 'chart-crosshair' })
  crosshair.style.display = 'none'
  const dot = svgEl('circle', { r: 5, class: 'chart-dot' })
  dot.style.display = 'none'
  svg.appendChild(crosshair)
  svg.appendChild(dot)

  const hitRect = svgEl('rect', { x: margin.left, y: margin.top, width: plotW, height: plotH, class: 'chart-hit' })
  svg.appendChild(hitRect)

  wrap.appendChild(svg)
  const tooltip = makeTooltip(wrap, svg, width, height)

  function nearestIndex(px) {
    let idx = 0, best = Infinity
    for (let i = 0; i < n; i++) {
      const d = Math.abs(x(i) - px)
      if (d < best) { best = d; idx = i }
    }
    return idx
  }

  function onMove(evt) {
    const rect = svg.getBoundingClientRect()
    const px = (evt.clientX - rect.left) * (width / rect.width)
    const i = nearestIndex(px)
    const cx = x(i), cy = y(valores[i])
    crosshair.setAttribute('x1', cx)
    crosshair.setAttribute('x2', cx)
    crosshair.style.display = ''
    dot.setAttribute('cx', cx)
    dot.setAttribute('cy', cy)
    dot.style.display = ''
    const f = filas[i]
    const r = f.resumen || {}
    tooltip.show([
      [fechaLabelLarga(f.fecha), '', true],
      ['Total', money(r.total)],
      ['Costo', money(r.costo)],
      ['Ganancia', money(r.gananciaBruta)],
      ['Tickets', num(r.tickets || 0)],
    ], cx, cy)
  }
  function onLeave() {
    crosshair.style.display = 'none'
    dot.style.display = 'none'
    tooltip.hide()
  }

  hitRect.addEventListener('pointermove', onMove)
  hitRect.addEventListener('pointerdown', onMove)
  hitRect.addEventListener('pointerleave', onLeave)
}

// ---------------------------------------------------------------------------
// Margen bruto % -- tendencia histórica (mismo eje X que renderLineChart,
// eje Y en % en vez de dinero). Copia deliberada de renderLineChart en vez
// de generalizarla con un parámetro más -- son pocas líneas y mantiene cada
// gráfico legible por separado, mismo criterio que ya usa este archivo para
// renderAuditoriaTendenciaChart.
// ---------------------------------------------------------------------------
export function renderMargenChart(container, filas, { pct }) {
  container.innerHTML = ''
  if (!filas || !filas.length) { container.appendChild(elEmpty('Todavía no hay suficiente histórico guardado.')); return }

  const wrap = document.createElement('div')
  wrap.className = 'chart-wrap'
  container.appendChild(wrap)

  const width = Math.max(320, wrap.clientWidth || container.clientWidth || 600)
  const height = 240
  const margin = { top: 16, right: 16, bottom: 34, left: 56 }
  const plotW = width - margin.left - margin.right
  const plotH = height - margin.top - margin.bottom

  const valores = filas.map((f) => (f.resumen || {}).margenPct || 0)
  // Eje Y en % -- niceTicks() está pensado para pesos, pero funciona igual
  // de bien con cualquier escala numérica (solo redondea a pasos "lindos").
  const maxVal = Math.max(...valores, 10)
  const { ticks, top } = niceTicks(maxVal)

  const svg = svgEl('svg', { viewBox: `0 0 ${width} ${height}`, preserveAspectRatio: 'xMinYMin meet', role: 'img', 'aria-label': 'Margen bruto % histórico' })
  const y = ejes(svg, { margin, width, height, plotW, plotH, ticks, top, money: pct })

  const n = filas.length
  const x = (i) => margin.left + (n === 1 ? plotW / 2 : (plotW * i) / (n - 1))

  const points = valores.map((v, i) => [x(i), y(v)])
  const linePath = points.map((p, i) => (i === 0 ? 'M' : 'L') + p[0].toFixed(1) + ',' + p[1].toFixed(1)).join(' ')

  svg.appendChild(svgEl('path', { d: linePath, class: 'chart-line', fill: 'none' }))

  decimatedIndices(n, plotW).forEach((i) => {
    const label = svgEl('text', { x: x(i), y: height - margin.bottom + 20, class: 'chart-axis-label', 'text-anchor': 'middle' })
    label.textContent = fechaLabel(filas[i].fecha)
    svg.appendChild(label)
  })

  const crosshair = svgEl('line', { y1: margin.top, y2: margin.top + plotH, class: 'chart-crosshair' })
  crosshair.style.display = 'none'
  const dot = svgEl('circle', { r: 5, class: 'chart-dot' })
  dot.style.display = 'none'
  svg.appendChild(crosshair)
  svg.appendChild(dot)

  const hitRect = svgEl('rect', { x: margin.left, y: margin.top, width: plotW, height: plotH, class: 'chart-hit' })
  svg.appendChild(hitRect)

  wrap.appendChild(svg)
  const tooltip = makeTooltip(wrap, svg, width, height)

  function nearestIndex(px) {
    let idx = 0, best = Infinity
    for (let i = 0; i < n; i++) {
      const d = Math.abs(x(i) - px)
      if (d < best) { best = d; idx = i }
    }
    return idx
  }

  function onMove(evt) {
    const rect = svg.getBoundingClientRect()
    const px = (evt.clientX - rect.left) * (width / rect.width)
    const i = nearestIndex(px)
    const cx = x(i), cy = y(valores[i])
    crosshair.setAttribute('x1', cx)
    crosshair.setAttribute('x2', cx)
    crosshair.style.display = ''
    dot.setAttribute('cx', cx)
    dot.setAttribute('cy', cy)
    dot.style.display = ''
    const f = filas[i]
    tooltip.show([
      [fechaLabelLarga(f.fecha), '', true],
      ['Margen bruto', pct(valores[i])],
    ], cx, cy)
  }
  function onLeave() {
    crosshair.style.display = 'none'
    dot.style.display = 'none'
    tooltip.hide()
  }

  hitRect.addEventListener('pointermove', onMove)
  hitRect.addEventListener('pointerdown', onMove)
  hitRect.addEventListener('pointerleave', onLeave)
}

// ---------------------------------------------------------------------------
// Auditoría de compra -- tendencia agregada de una marca, 3 barras.
// ---------------------------------------------------------------------------
export function renderAuditoriaTendenciaChart(container, buckets, { num }) {
  container.innerHTML = ''
  if (!buckets || !buckets.length) { container.appendChild(elEmpty('Sin datos para graficar.')); return }

  const wrap = document.createElement('div')
  wrap.className = 'chart-wrap'
  container.appendChild(wrap)

  const width = Math.max(320, wrap.clientWidth || container.clientWidth || 600)
  const height = 240
  const margin = { top: 16, right: 12, bottom: 34, left: 56 }
  const plotW = width - margin.left - margin.right
  const plotH = height - margin.top - margin.bottom

  const maxVal = Math.max(...buckets.map((b) => b.cantidad), 1)
  const { ticks, top } = niceTicks(maxVal)

  const svg = svgEl('svg', { viewBox: `0 0 ${width} ${height}`, preserveAspectRatio: 'xMinYMin meet', role: 'img', 'aria-label': 'Unidades vendidas por mes' })
  ejes(svg, { margin, width, height, plotW, plotH, ticks, top, money: num })

  const n = buckets.length
  const bandW = plotW / n
  const barW = Math.min(100, bandW * 0.6)

  const barsGroup = svgEl('g')
  buckets.forEach((b, i) => {
    const cx = margin.left + bandW * i + bandW / 2
    const barH = Math.max(2, (b.cantidad / top) * plotH)
    const barY = margin.top + plotH - barH
    const path = svgEl('path', {
      d: roundedTopBarPath(cx - barW / 2, barY, barW, barH, 6),
      class: 'chart-bar', tabindex: '0', role: 'img',
      'aria-label': `${b.label}: ${num(b.cantidad)} unidades`,
    })
    barsGroup.appendChild(path)
  })
  svg.appendChild(barsGroup)

  buckets.forEach((b, i) => {
    const cx = margin.left + bandW * i + bandW / 2
    const label = svgEl('text', { x: cx, y: height - margin.bottom + 20, class: 'chart-axis-label', 'text-anchor': 'middle' })
    label.textContent = b.label
    svg.appendChild(label)
  })

  wrap.appendChild(svg)
  const tooltip = makeTooltip(wrap, svg, width, height)

  barsGroup.querySelectorAll('path').forEach((bar, i) => {
    const b = buckets[i]
    const cx = margin.left + bandW * i + bandW / 2
    const barH = Math.max(2, (b.cantidad / top) * plotH)
    const barY = margin.top + plotH - barH
    const mostrar = () => {
      bar.classList.add('chart-bar-hover')
      const rows = [[b.rango, '', true], ['Unidades vendidas', num(b.cantidad)]]
      if (b.crecimientoPct !== null && b.crecimientoPct !== undefined) {
        rows.push(['Vs. mes anterior', (b.crecimientoPct >= 0 ? '+' : '') + b.crecimientoPct.toFixed(1) + '%'])
      }
      tooltip.show(rows, cx, barY)
    }
    const ocultar = () => { bar.classList.remove('chart-bar-hover'); tooltip.hide() }
    bar.addEventListener('pointerenter', mostrar)
    bar.addEventListener('pointermove', mostrar)
    bar.addEventListener('pointerleave', ocultar)
    bar.addEventListener('focus', mostrar)
    bar.addEventListener('blur', ocultar)
  })
}
