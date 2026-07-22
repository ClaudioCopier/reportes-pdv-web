import { createClient } from '@supabase/supabase-js'

// El cliente de Supabase se crea recién después de un login válido: la
// URL/clave las entrega el servidor (/api/entrar) sólo cuando la clave de
// acceso es correcta, así ni la clave ni las credenciales viajan en el
// bundle público. Ver SERVIDOR.md (Fase A del endurecimiento de accesos).
let supabase = null
const SESION_KEY = 'reportes_pdv_sesion'

const money = (n) => '$' + Number(n || 0).toLocaleString('es-CL', { maximumFractionDigits: 0 })
const num = (n) => Number(n || 0).toLocaleString('es-CL', { maximumFractionDigits: 0 })
const dec = (n, d = 1) => Number(n || 0).toLocaleString('es-CL', { minimumFractionDigits: d, maximumFractionDigits: d })
const pct = (n) => dec(n, 1) + '%'

function el(html) {
  const t = document.createElement('template')
  t.innerHTML = html.trim()
  return t.content.firstChild
}

// ---------------------------------------------------------------------------
// Clave de acceso: la validación ocurre en el servidor (/api/entrar). Recién
// cuando la clave es correcta, el servidor entrega la URL/clave de Supabase,
// que se guarda en sessionStorage (dura mientras la pestaña siga abierta) y
// se usa para crear el cliente. Así nadie obtiene credenciales funcionales
// sin pasar el login. Ver SERVIDOR.md.
// ---------------------------------------------------------------------------
function activarSesion(supabaseUrl, supabaseAnonKey) {
  supabase = createClient(supabaseUrl, supabaseAnonKey)
  document.getElementById('gate').style.display = 'none'
  document.getElementById('appRoot').style.display = ''
  initApp()
}

function iniciarGate() {
  const guardado = sessionStorage.getItem(SESION_KEY)
  if (guardado) {
    try {
      const { url, key } = JSON.parse(guardado)
      if (url && key) { activarSesion(url, key); return }
    } catch { /* sesión corrupta, se pide login de nuevo */ }
  }

  document.getElementById('gateForm').addEventListener('submit', async (e) => {
    e.preventDefault()
    const intentada = document.getElementById('gateClave').value
    const errorEl = document.getElementById('gateError')
    const btn = e.target.querySelector('button')
    btn.disabled = true
    errorEl.textContent = ''
    try {
      const resp = await fetch('/api/entrar', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clave: intentada }),
      })
      const data = await resp.json().catch(() => ({}))
      if (resp.ok && data.ok) {
        sessionStorage.setItem(SESION_KEY, JSON.stringify({ url: data.supabaseUrl, key: data.supabaseAnonKey }))
        activarSesion(data.supabaseUrl, data.supabaseAnonKey)
      } else {
        errorEl.textContent = data.error || 'Clave incorrecta.'
      }
    } catch (err) {
      errorEl.textContent = 'No se pudo conectar con el servidor. Reintentá.'
    } finally {
      btn.disabled = false
    }
  })
}

// ---------------------------------------------------------------------------
// Estado
// ---------------------------------------------------------------------------
const RANGOS_RAPIDOS = [
  { clave: 'hoy', label: 'Hoy' },
  { clave: 'ayer', label: 'Ayer' },
  { clave: 'semana', label: 'Esta semana' },
  { clave: 'mes', label: 'Este mes' },
  { clave: 'mes_pasado', label: 'Mes pasado' },
]

let claveActual = 'hoy';
let modoHistorico = false;
let rotacionData = []
let sortState = { key: 'ingreso', dir: -1 }

function renderQuickRanges() {
  const box = document.getElementById('quickRanges')
  box.innerHTML = ''
  RANGOS_RAPIDOS.forEach((r) => {
    const btn = el(`<button data-clave="${r.clave}">${r.label}</button>`)
    btn.addEventListener('click', () => {
      modoHistorico = false
      claveActual = r.clave
      markActiveQuick()
      cargar()
    })
    box.appendChild(btn)
  })
}

function markActiveQuick() {
  const box = document.getElementById('quickRanges')
  ;[...box.children].forEach((btn) => {
    btn.classList.toggle('active', !modoHistorico && btn.dataset.clave === claveActual)
  })
}

// ---------------------------------------------------------------------------
// KPIs
// ---------------------------------------------------------------------------
function compareSub(current, prev, invertColor = false) {
  if (prev === undefined || prev === null) return ''
  const diff = current - prev
  const diffPct = prev !== 0 ? (diff / prev) * 100 : (current > 0 ? 100 : 0)
  let up = diff >= 0
  if (invertColor) up = !up
  const cls = up ? 'kpi-up' : 'kpi-down'
  const arrow = diff >= 0 ? '▲' : '▼'
  return `<div class="kpi-sub ${cls}">${arrow} ${dec(Math.abs(diffPct))}% vs periodo anterior</div>`
}

function renderKpis(data) {
  const box = document.getElementById('kpis')
  box.innerHTML = ''
  const r = data.resumen, p = data.resumenAnterior
  const cards = [
    { label: 'Ventas (ingreso bruto)', value: money(r.total), sub: compareSub(r.total, p.total) },
    { label: 'Costo de mercadería', value: money(r.costo), sub: compareSub(r.costo, p.costo, true) },
    { label: 'Ganancia bruta', value: money(r.gananciaBruta), sub: compareSub(r.gananciaBruta, p.gananciaBruta) },
    { label: 'Margen bruto', value: pct(r.margenPct), sub: compareSub(r.margenPct, p.margenPct) },
    { label: 'Tickets', value: num(r.tickets), sub: compareSub(r.tickets, p.tickets) },
    { label: 'Ticket promedio', value: money(r.ticketPromedio), sub: compareSub(r.ticketPromedio, p.ticketPromedio) },
  ]
  cards.forEach((c) => {
    box.appendChild(el(`
      <div class="kpi-card">
        <div class="kpi-label">${c.label}</div>
        <div class="kpi-value">${c.value}</div>
        ${c.sub || ''}
      </div>
    `))
  })
}

// ---------------------------------------------------------------------------
// Gráfico de ventas diarias
// ---------------------------------------------------------------------------
function renderChart(dias) {
  const box = document.getElementById('chartVentas')
  box.innerHTML = ''
  if (!dias.length) { box.appendChild(el('<div class="empty">Sin datos en este periodo.</div>')); return }
  const max = Math.max(...dias.map((d) => d.total), 1)
  dias.forEach((d) => {
    const h = Math.max(2, Math.round((d.total / max) * 170))
    const fecha = new Date(d.dia + 'T00:00:00')
    const label = fecha.toLocaleDateString('es-CL', { day: '2-digit', month: '2-digit' })
    box.appendChild(el(`
      <div class="bar-col">
        <div class="bar-tooltip">${label}: ${money(d.total)} · costo ${money(d.costo)} · ganancia ${money(d.gananciaBruta)} (${d.tickets} tickets)</div>
        <div class="bar" style="height:${h}px"></div>
        <div class="bar-label">${label}</div>
      </div>
    `))
  })
}

// ---------------------------------------------------------------------------
// Rotación de productos (tabla completa, ordenable y filtrable)
// ---------------------------------------------------------------------------
const ROTACION_COLS = [
  { key: 'nombre', label: 'Producto', num: false },
  { key: 'departamento', label: 'Departamento', num: false },
  { key: 'cantidad', label: 'Cant.', num: true, fmt: num },
  { key: 'ingreso', label: 'Ingreso', num: true, fmt: money },
  { key: 'costo', label: 'Costo', num: true, fmt: money },
  { key: 'gananciaBruta', label: 'Ganancia', num: true, fmt: money },
  { key: 'margenPct', label: 'Margen %', num: true, fmt: pct },
  { key: 'pctDeIngresoTotal', label: '% del total', num: true, fmt: (v) => dec(v, 2) + '%' },
  { key: 'velocidadDia', label: 'Unid./día', num: true, fmt: (v) => dec(v, 2) },
  { key: 'existencia', label: 'Existencia', num: true, fmt: (v) => v === null ? '—' : num(v) },
  { key: 'diasDeInventario', label: 'Días inv.', num: true, fmt: (v) => v === null ? '—' : dec(v, 0) },
  { key: 'clasificacionABC', label: 'ABC', num: false },
]

function populateDeptoFilter(productos) {
  const sel = document.getElementById('filtroDepto')
  const current = sel.value
  const deptos = [...new Set(productos.map((p) => p.departamento))].sort()
  sel.innerHTML = '<option value="">Todos los departamentos</option>' +
    deptos.map((d) => `<option value="${d}">${d}</option>`).join('')
  sel.value = current && deptos.includes(current) ? current : ''
}

function renderRotacion() {
  const box = document.getElementById('rotacionProductos')
  const texto = document.getElementById('filtroProducto').value.trim().toLowerCase()
  const depto = document.getElementById('filtroDepto').value

  let filas = rotacionData.filter((p) => {
    if (depto && p.departamento !== depto) return false
    if (texto && !p.nombre.toLowerCase().includes(texto) && !p.codigo.toLowerCase().includes(texto)) return false
    return true
  })

  filas.sort((a, b) => {
    const va = a[sortState.key], vb = b[sortState.key]
    if (va === null) return 1
    if (vb === null) return -1
    if (typeof va === 'string') return va.localeCompare(vb) * sortState.dir
    return (va - vb) * sortState.dir
  })

  box.innerHTML = ''
  if (!filas.length) { box.appendChild(el('<div class="empty">Sin ventas en este periodo (con los filtros actuales).</div>')); return }

  const thead = ROTACION_COLS.map((c) => {
    const arrow = sortState.key === c.key ? (sortState.dir === 1 ? '▲' : '▼') : ''
    return `<th class="sortable ${c.num ? 'num' : ''}" data-key="${c.key}">${c.label}<span class="arrow">${arrow}</span></th>`
  }).join('')

  const rows = filas.map((p) => {
    const cells = ROTACION_COLS.map((c) => {
      if (c.key === 'clasificacionABC') {
        return `<td><span class="abc-badge abc-${p.clasificacionABC.toLowerCase()}">${p.clasificacionABC}</span></td>`
      }
      const raw = p[c.key]
      const display = c.fmt ? c.fmt(raw) : raw
      const tag = c.key === 'nombre' && p.estimado ? '<span class="estimado-tag" title="Incluye ventas de hoy estimadas del log, todavía no confirmadas por un respaldo">HOY: EST.</span>' : ''
      return `<td class="${c.num ? 'num' : ''}">${display}${tag}</td>`
    }).join('')
    return `<tr>${cells}</tr>`
  }).join('')

  const table = el(`<table><thead><tr>${thead}</tr></thead><tbody>${rows}</tbody></table>`)
  table.querySelectorAll('th.sortable').forEach((th) => {
    th.addEventListener('click', () => {
      const key = th.dataset.key
      if (sortState.key === key) sortState.dir *= -1
      else sortState = { key, dir: -1 }
      renderRotacion()
    })
  })
  box.appendChild(table)
}

// ---------------------------------------------------------------------------
// Tablas simples
// ---------------------------------------------------------------------------
function renderTable(containerId, headers, rows, rowRenderer, emptyMsg) {
  const box = document.getElementById(containerId)
  box.innerHTML = ''
  if (!rows.length) { box.appendChild(el(`<div class="empty">${emptyMsg}</div>`)); return }
  const table = el(`<table><thead><tr>${headers.map((h) => `<th class="${h.num ? 'num' : ''}">${h.label}</th>`).join('')}</tr></thead><tbody></tbody></table>`)
  const tbody = table.querySelector('tbody')
  rows.forEach((r) => tbody.appendChild(el(rowRenderer(r))))
  box.appendChild(table)
}

function renderCashflow(caja) {
  const box = document.getElementById('cashflowKpis')
  box.innerHTML = ''
  const cards = [
    { label: `Entradas de caja (${caja.entradasCaja.veces})`, value: money(caja.entradasCaja.total) },
    { label: `Salidas de caja (${caja.salidasCaja.veces})`, value: money(caja.salidasCaja.total) },
    { label: `Pagos de abonos recibidos (${caja.pagosAbonos.veces})`, value: money(caja.pagosAbonos.total) },
  ]
  cards.forEach((c) => box.appendChild(el(`<div class="cashflow-kpi"><div class="lbl">${c.label}</div><div class="val">${c.value}</div></div>`)))

  renderTable('salidasCategoria',
    [{ label: 'Categoría de salida' }, { label: 'N° movimientos', num: true }, { label: 'Total', num: true }],
    caja.salidasPorCategoria,
    (c) => `<tr><td>${c.categoria}</td><td class="num">${num(c.veces)}</td><td class="num">${money(c.total)}</td></tr>`,
    'Sin salidas de caja en este periodo.'
  )
}

// ---------------------------------------------------------------------------
// Aviso de datos en vivo (hoy, reconstruidos del log del POS)
// ---------------------------------------------------------------------------
function renderVivoBanner(info) {
  const box = document.getElementById('vivoBanner')
  if (!info || !info.activo) { box.style.display = 'none'; return }
  const desde = info.cutoff ? new Date(info.cutoff).toLocaleString('es-CL') : ''
  box.style.display = 'flex'
  box.innerHTML = `⚡ Incluye <b>${info.ticketsEnVivo}</b> venta(s) de hoy en vivo, reconstruidas directamente del registro del POS (todavía sin confirmar por un respaldo). Base de datos actualizada hasta ${desde}. El detalle por producto de esas ventas es una estimación (marcado <span class="estimado-tag">HOY: EST.</span>).`
}

// ---------------------------------------------------------------------------
// Carga principal -- lee directo de Supabase, nunca calcula nada acá.
// ---------------------------------------------------------------------------
function pintar(datos) {
  renderVivoBanner(datos.datosEnVivo)
  renderKpis(datos)
  renderChart(datos.ventasDiarias)

  rotacionData = datos.rotacionProductos
  populateDeptoFilter(rotacionData)
  renderRotacion()

  renderTable('porDepartamento',
    [{ label: 'Departamento' }, { label: 'Cant.', num: true }, { label: 'Ingreso', num: true }, { label: 'Costo', num: true }, { label: 'Ganancia', num: true }, { label: 'Margen %', num: true }],
    datos.rotacionPorDepartamento,
    (r) => `<tr><td>${r.departamento}</td><td class="num">${num(r.cantidad)}</td><td class="num">${money(r.ingreso)}</td><td class="num">${money(r.costo)}</td><td class="num">${money(r.gananciaBruta)}</td><td class="num">${pct(r.margenPct)}</td></tr>`,
    'Sin ventas en este periodo.'
  )

  renderTable('formasPago',
    [{ label: 'Forma de pago' }, { label: 'Tickets', num: true }, { label: 'Total', num: true }],
    datos.formasPago,
    (r) => `<tr><td>${r.forma}</td><td class="num">${num(r.tickets)}</td><td class="num">${money(r.total)}</td></tr>`,
    'Sin ventas en este periodo.'
  )

  renderCashflow(datos.flujoCaja)

  document.getElementById('stockCount').textContent = datos.stockBajo.length
  renderTable('stockBajo',
    [{ label: 'Producto' }, { label: 'Existencia', num: true }, { label: 'Mínimo', num: true }],
    datos.stockBajo,
    (r) => `<tr class="low-stock-row"><td>${r.descripcion}</td><td class="num">${num(r.existencia)}</td><td class="num">${num(r.minimo)}</td></tr>`,
    'Ningún producto con stock bajo. 🎉'
  )
}

async function cargar() {
  const statusEl = document.getElementById('status')
  statusEl.textContent = 'Cargando...'

  if (modoHistorico) {
    const fecha = document.getElementById('fDia').value
    const { data, error } = await supabase
      .from('reportes_ventas_historico')
      .select('datos, actualizado_en')
      .eq('fecha', fecha)
      .maybeSingle()
    if (error) { statusEl.textContent = 'Error: ' + error.message; return }
    if (!data) { statusEl.textContent = 'Sin reporte guardado para ese día.'; return }
    pintar(data.datos)
    statusEl.textContent = `Día ${fecha} — actualizado ${new Date(data.actualizado_en).toLocaleString('es-CL')}`
    return
  }

  const { data, error } = await supabase
    .from('reportes_ventas_actual')
    .select('datos, actualizado_en')
    .eq('clave', claveActual)
    .maybeSingle()
  if (error) { statusEl.textContent = 'Error: ' + error.message; return }
  if (!data) { statusEl.textContent = 'Todavía no hay datos publicados (el agente de la tienda no corrió aún).'; return }
  pintar(data.datos)
  statusEl.textContent = 'Actualizado ' + new Date(data.actualizado_en).toLocaleString('es-CL')
}

// ---------------------------------------------------------------------------
// Actualizar ahora -- el agente de la tienda ya NO recalcula solo cada pocos
// minutos (para no generar carga de fondo en Supabase sin motivo); esto pide
// una actualización puntual insertando una fila en reportes_solicitudes
// (mismo mecanismo que ya usa la sincronización de inventario) y espera a
// que el agente la procese antes de releer los datos frescos.
// ---------------------------------------------------------------------------
async function solicitarActualizacion() {
  if (modoHistorico) { cargar(); return } // los días pasados ya están cerrados, no hace falta pedir nada

  const statusEl = document.getElementById('status')
  const btn = document.getElementById('btnRefresh')
  btn.disabled = true
  statusEl.textContent = 'Solicitando actualización a la tienda...'

  try {
    const { data, error } = await supabase
      .from('reportes_solicitudes')
      .insert({})
      .select('id')
      .single()
    if (error) { statusEl.textContent = 'Error: ' + error.message; return }

    const inicio = Date.now()
    const TIMEOUT_MS = 100000
    while (true) {
      await new Promise((r) => setTimeout(r, 1500))
      const { data: row, error: errRow } = await supabase
        .from('reportes_solicitudes')
        .select('status, mensaje')
        .eq('id', data.id)
        .maybeSingle()
      if (errRow) { statusEl.textContent = 'Error: ' + errRow.message; return }
      if (row?.status === 'done') { await cargar(); return }
      if (row?.status === 'error') { statusEl.textContent = 'Error del agente: ' + (row.mensaje || 'sin detalle'); return }
      if (Date.now() - inicio > TIMEOUT_MS) {
        statusEl.textContent = 'La tienda no respondió a tiempo (¿está abierto el agente en la PC?). Mostrando la última información disponible.'
        return
      }
      statusEl.textContent = row?.status === 'running'
        ? 'Actualizando datos en la tienda...'
        : 'Esperando que el agente de la tienda tome la solicitud...'
    }
  } finally {
    btn.disabled = false
  }
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------
function initApp() {
  renderQuickRanges()
  markActiveQuick()

  document.getElementById('btnRefresh').addEventListener('click', solicitarActualizacion)
  document.getElementById('btnVerDia').addEventListener('click', () => {
    if (!document.getElementById('fDia').value) return
    modoHistorico = true
    markActiveQuick()
    cargar()
  })
  document.getElementById('filtroProducto').addEventListener('input', renderRotacion)
  document.getElementById('filtroDepto').addEventListener('change', renderRotacion)

  cargar()
}

iniciarGate()
