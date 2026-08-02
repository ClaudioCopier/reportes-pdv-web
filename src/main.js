import { createClient } from '@supabase/supabase-js'
import { renderBarChart, renderLineChart } from './chart.js'

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

const startOfDay = (d) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x }
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x }
const toISO = (d) => {
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}
// Cantidad de días entre dos fechas ISO "YYYY-MM-DD", ambas inclusive.
const diasEntre = (desdeStr, hastaStr) => Math.round((new Date(hastaStr) - new Date(desdeStr)) / 86400000) + 1

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
  { clave: 'hoy', label: 'Hoy', tipo: 'rapido' },
  { clave: 'ayer', label: 'Ayer', tipo: 'rapido' },
  { clave: 'semana', label: 'Esta semana', tipo: 'rapido' },
  { clave: 'mes', label: 'Este mes', tipo: 'rapido' },
  { clave: 'mes_pasado', label: 'Mes pasado', tipo: 'rapido' },
]
// Rangos "últimos N días" -- no tienen fila propia en reportes_ventas_actual,
// se resuelven como un rango personalizado (mismo mecanismo que fDesde/fHasta,
// combina reportes_ventas_historico) pero con un solo clic.
const RANGOS_ULTIMOS = [
  { clave: 'ultimos_7', dias: 7, label: 'Últimos 7 días', tipo: 'ultimos' },
  { clave: 'ultimos_15', dias: 15, label: 'Últimos 15 días', tipo: 'ultimos' },
  { clave: 'ultimos_30', dias: 30, label: 'Últimos 30 días', tipo: 'ultimos' },
  { clave: 'ultimos_90', dias: 90, label: 'Últimos 90 días', tipo: 'ultimos' },
]
const TODOS_CHIPS = [...RANGOS_RAPIDOS, ...RANGOS_ULTIMOS]

// Default "Este mes" -- para que "Rotación de productos" no arranque vacía
// mostrando solo el día de hoy (ver plan: stats.js ya calcula la velocidad
// de venta dividiendo por los días activos transcurridos del mes, esto solo
// cambia qué se ve al abrir el sitio).
let claveActual = 'mes';
let modo = 'rapido'; // 'rapido' (reportes_ventas_actual) | 'rango' (fDesde/fHasta o "últimos N días", combina reportes_ventas_historico)
let chipActivo = 'mes' // clave del chip resaltado arriba, o null si el rango activo vino del formulario manual
let rangoDesde = null
let rangoHasta = null
let fechaMinimaHistorico = null // más vieja fecha real guardada en reportes_ventas_historico
let rotacionData = []
let sortState = { key: 'ingreso', dir: -1 }

function renderQuickRanges() {
  const box = document.getElementById('quickRanges')
  box.innerHTML = ''
  TODOS_CHIPS.forEach((r) => {
    const btn = el(`<button data-clave="${r.clave}">${r.label}</button>`)
    btn.addEventListener('click', () => {
      chipActivo = r.clave
      if (r.tipo === 'rapido') {
        modo = 'rapido'
        claveActual = r.clave
      } else {
        modo = 'rango'
        const hoy = startOfDay(new Date())
        rangoHasta = toISO(hoy)
        rangoDesde = toISO(addDays(hoy, -(r.dias - 1)))
        document.getElementById('fDesde').value = rangoDesde
        document.getElementById('fHasta').value = rangoHasta
      }
      markActiveQuick()
      cargar()
    })
    box.appendChild(btn)
  })
}

function markActiveQuick() {
  const box = document.getElementById('quickRanges')
  ;[...box.children].forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.clave === chipActivo)
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
  const r = data.resumen, p = data.resumenAnterior || {}
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
// Tendencia histórica -- todo reportes_ventas_historico, independiente del
// periodo seleccionado arriba. Trae solo el resumen de cada día (path JSON
// de Postgres, ~36KB por día completo si se bajara entero, evitado a
// propósito) y se carga una sola vez al abrir el sitio.
// ---------------------------------------------------------------------------
async function cargarTendencia() {
  const box = document.getElementById('chartTendencia')
  const { data, error } = await supabase
    .from('reportes_ventas_historico')
    .select('fecha, resumen:datos->resumen')
    .order('fecha')
  if (error) {
    box.innerHTML = ''
    const d = document.createElement('div')
    d.className = 'empty'
    d.textContent = 'No se pudo cargar la tendencia: ' + error.message
    box.appendChild(d)
    return
  }
  renderLineChart(box, data || [], { money, num })
}

// ---------------------------------------------------------------------------
// Salud del agente -- heartbeat independiente de si alguien pidió un
// reporte (con el modelo a pedido, reportes_ventas_actual.actualizado_en
// viejo ya no implica que algo falló). Se revisa una vez al abrir el sitio.
// ---------------------------------------------------------------------------
async function cargarSalud() {
  const box = document.getElementById('agenteBanner')
  const { data, error } = await supabase.from('agente_estado').select('ultimo_latido').eq('id', 1).maybeSingle()
  if (error || !data) { box.style.display = 'none'; return }
  const ultimo = new Date(data.ultimo_latido)
  const minutos = Math.round((Date.now() - ultimo.getTime()) / 60000)
  if (minutos > 45) {
    box.style.display = 'flex'
    box.innerHTML = `⚠ El agente de la tienda no responde hace ${minutos} min (último aviso: ${ultimo.toLocaleString('es-CL')}). Revisar que la PC de la tienda y el agente sigan encendidos.`
  } else {
    box.style.display = 'none'
  }
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
// Cuentas internas (forma_pago "Crédito" -- retiro de vencidos, venta a
// precio costo a familiares, la cuenta del jefe) -- ver stats.js::
// cuentasInternas(). Oculto detrás de un botón a propósito (no es para
// mirar todos los días, solo para fiscalizar de vez en cuando).
// ---------------------------------------------------------------------------
let internasVisibles = false

function renderCuentasInternas(internas) {
  const btn = document.getElementById('btnToggleInternas')
  const boxResumen = document.getElementById('cuentasInternasResumen')
  const boxDetalle = document.getElementById('cuentasInternasDetalle')

  const datos = internas || { movimientos: [], porCuenta: [], total: 0 }
  btn.textContent = `${internasVisibles ? 'Ocultar' : 'Ver detalle'} (${datos.movimientos.length}, ${money(datos.total)})`

  boxResumen.style.display = internasVisibles ? '' : 'none'
  boxDetalle.style.display = internasVisibles ? '' : 'none'
  if (!internasVisibles) return

  renderTable('cuentasInternasResumen',
    [{ label: 'Cuenta' }, { label: 'Movimientos', num: true }, { label: 'Total', num: true }],
    datos.porCuenta,
    (r) => `<tr><td>${r.cuenta}</td><td class="num">${num(r.tickets)}</td><td class="num">${money(r.total)}</td></tr>`,
    'Sin movimientos en este periodo.'
  )

  renderTable('cuentasInternasDetalle',
    [{ label: 'Fecha' }, { label: 'Cuenta' }, { label: 'Cajero' }, { label: 'Artículos' }, { label: 'Total', num: true }],
    datos.movimientos,
    (m) => {
      const arts = (m.articulos || []).map((a) => `${a.nombre || a.codigo} ×${dec(a.cantidad, 2)}`).join(', ') || '—'
      return `<tr><td>${new Date(m.vendidoEn).toLocaleString('es-CL')}</td><td>${m.cuenta}</td><td>${m.cajero}</td><td>${arts}</td><td class="num">${money(m.total)}</td></tr>`
    },
    'Sin movimientos en este periodo.'
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
// Rango personalizado -- combina N días de reportes_ventas_historico
// client-side. Mismo criterio de clasificación ABC (Pareto 80/95) que ya usa
// agente-servidor/lib/stats.js::rotacionProductos, portado acá.
// ---------------------------------------------------------------------------
function calcularABC(productos) {
  const totalIngreso = productos.reduce((s, p) => s + p.ingreso, 0)
  const ordenados = [...productos].sort((a, b) => b.ingreso - a.ingreso)
  let acumulado = 0
  return ordenados.map((p) => {
    acumulado += p.ingreso
    const pctAcumulado = totalIngreso > 0 ? (acumulado / totalIngreso) * 100 : 0
    return {
      ...p,
      pctDeIngresoTotal: totalIngreso > 0 ? (p.ingreso / totalIngreso) * 100 : 0,
      clasificacionABC: pctAcumulado <= 80 ? 'A' : pctAcumulado <= 95 ? 'B' : 'C',
    }
  })
}

// dias: [{ fecha, datos }] ascendente por fecha, datos = forma que devuelve
// stats.dashboard() calculado para ESE día (una fila de reportes_ventas_historico,
// o la clave 'hoy' de reportes_ventas_actual si el rango incluye hoy).
// stockBajo y resumenAnterior (comparativo) NO se combinan -- son una foto
// del momento, sumarlos entre días no tiene sentido; se avisa en rangoBanner.
function combinarDias(dias) {
  const n = dias.length
  if (!n) return null

  let tickets = 0, articulos = 0, subtotal = 0, impuestos = 0, total = 0, costo = 0, gananciaBruta = 0
  for (const { datos } of dias) {
    const r = datos.resumen
    tickets += r.tickets; articulos += r.articulos || 0; subtotal += r.subtotal
    impuestos += r.impuestos; total += r.total; costo += r.costo; gananciaBruta += r.gananciaBruta
  }
  const resumen = {
    tickets, articulos, subtotal, impuestos, total, costo, gananciaBruta,
    margenPct: total > 0 ? (gananciaBruta / total) * 100 : 0,
    ticketPromedio: tickets > 0 ? total / tickets : 0,
  }

  const ventasDiarias = dias.flatMap((d) => d.datos.ventasDiarias)

  const porCodigo = new Map()
  for (const { datos } of dias) {
    for (const p of datos.rotacionProductos) {
      const cur = porCodigo.get(p.codigo) || { codigo: p.codigo, nombre: p.nombre, departamento: p.departamento, cantidad: 0, ingreso: 0, costo: 0, existencia: null, estimado: false }
      cur.cantidad += p.cantidad
      cur.ingreso += p.ingreso
      cur.costo += p.costo
      if (p.existencia !== null) cur.existencia = p.existencia // dias viene ascendente: el último no-nulo gana (más reciente)
      cur.estimado = cur.estimado || p.estimado
      porCodigo.set(p.codigo, cur)
    }
  }
  let productos = [...porCodigo.values()].map((p) => {
    const ganancia = p.ingreso - p.costo
    const velocidadDia = p.cantidad / n
    return {
      ...p,
      gananciaBruta: ganancia,
      margenPct: p.ingreso > 0 ? (ganancia / p.ingreso) * 100 : 0,
      velocidadDia,
      diasDeInventario: p.existencia !== null && p.existencia > -1 && velocidadDia > 0 ? p.existencia / velocidadDia : null,
    }
  })
  productos = calcularABC(productos)

  const porDepto = new Map()
  for (const { datos } of dias) {
    for (const d of datos.rotacionPorDepartamento) {
      const cur = porDepto.get(d.departamento) || { departamento: d.departamento, productosDistintos: 0, cantidad: 0, ingreso: 0, costo: 0 }
      cur.cantidad += d.cantidad; cur.ingreso += d.ingreso; cur.costo += d.costo
      cur.productosDistintos = Math.max(cur.productosDistintos, d.productosDistintos)
      porDepto.set(d.departamento, cur)
    }
  }
  const rotacionPorDepartamento = [...porDepto.values()]
    .map((d) => { const g = d.ingreso - d.costo; return { ...d, gananciaBruta: g, margenPct: d.ingreso > 0 ? (g / d.ingreso) * 100 : 0 } })
    .sort((a, b) => b.ingreso - a.ingreso)

  const porForma = new Map()
  for (const { datos } of dias) {
    for (const f of datos.formasPago) {
      const cur = porForma.get(f.forma) || { forma: f.forma, tickets: 0, total: 0 }
      cur.tickets += f.tickets; cur.total += f.total
      porForma.set(f.forma, cur)
    }
  }
  const formasPago = [...porForma.values()].sort((a, b) => b.total - a.total)

  const porCajero = new Map()
  for (const { datos } of dias) {
    // días guardados antes de la Fase D no tienen este campo todavía
    for (const c of datos.ventasPorCajero || []) {
      const cur = porCajero.get(c.cajero) || { cajero: c.cajero, tickets: 0, total: 0, gananciaBruta: 0 }
      cur.tickets += c.tickets; cur.total += c.total; cur.gananciaBruta += c.gananciaBruta
      porCajero.set(c.cajero, cur)
    }
  }
  const ventasPorCajero = [...porCajero.values()].sort((a, b) => b.total - a.total)

  const entradasCaja = { total: 0, veces: 0 }, salidasCaja = { total: 0, veces: 0 }, pagosAbonos = { total: 0, veces: 0 }
  const porCategoria = new Map()
  for (const { datos } of dias) {
    const c = datos.flujoCaja
    entradasCaja.total += c.entradasCaja.total; entradasCaja.veces += c.entradasCaja.veces
    salidasCaja.total += c.salidasCaja.total; salidasCaja.veces += c.salidasCaja.veces
    pagosAbonos.total += c.pagosAbonos.total; pagosAbonos.veces += c.pagosAbonos.veces
    for (const cat of c.salidasPorCategoria) {
      const cur = porCategoria.get(cat.categoria) || { categoria: cat.categoria, total: 0, veces: 0 }
      cur.total += cat.total; cur.veces += cat.veces
      porCategoria.set(cat.categoria, cur)
    }
  }
  const flujoCaja = { entradasCaja, salidasCaja, pagosAbonos, salidasPorCategoria: [...porCategoria.values()].sort((a, b) => b.total - a.total) }

  // días guardados antes de esta sección no tienen datos.cuentasInternas todavía
  const movimientosInternas = dias.flatMap((d) => (d.datos.cuentasInternas || {}).movimientos || [])
  const porCuentaInternas = new Map()
  for (const m of movimientosInternas) {
    const cur = porCuentaInternas.get(m.cuenta) || { cuenta: m.cuenta, tickets: 0, total: 0 }
    cur.tickets += 1; cur.total += m.total
    porCuentaInternas.set(m.cuenta, cur)
  }
  const cuentasInternas = {
    movimientos: movimientosInternas.sort((a, b) => new Date(b.vendidoEn) - new Date(a.vendidoEn)),
    porCuenta: [...porCuentaInternas.values()].sort((a, b) => b.total - a.total),
    total: movimientosInternas.reduce((s, m) => s + m.total, 0),
  }

  const ultimoVivo = dias[n - 1].datos.datosEnVivo
  return {
    periodo: { desde: dias[0].fecha, hasta: dias[n - 1].fecha },
    resumen,
    resumenAnterior: null,
    datosEnVivo: ultimoVivo && ultimoVivo.activo ? ultimoVivo : { activo: false, ticketsEnVivo: 0, cutoff: null },
    ventasDiarias,
    rotacionProductos: productos,
    rotacionPorDepartamento,
    formasPago,
    ventasPorCajero,
    stockBajo: [],
    flujoCaja,
    cuentasInternas,
  }
}

// Mensaje del banner de rango personalizado -- explica de forma explícita
// cuando el histórico guardado no llega a cubrir todo lo pedido (en vez de
// que el gráfico/tabla simplemente se vean "cortos" sin avisar). Ver plan:
// el histórico recién empezó a guardarse hace poco, así que hoy es normal
// pedir 30 días y encontrar menos -- no es un bug, pero tiene que decirse.
function renderRangoBanner(diasEncontrados, desdeStr, hastaStr) {
  const box = document.getElementById('rangoBanner')
  if (modo !== 'rango') { box.style.display = 'none'; return }
  box.style.display = 'flex'

  let msg = 'ℹ Rango personalizado: el comparativo con el periodo anterior y "Stock bajo" no están disponibles en este modo (son una foto del momento, no se pueden sumar entre días) — usá los rangos rápidos de arriba para verlos.'
  if (desdeStr && hastaStr) {
    const diasPedidos = diasEntre(desdeStr, hastaStr)
    if (diasEncontrados < diasPedidos) {
      const desdeHist = fechaMinimaHistorico ? fechaMinimaHistorico.split('-').reverse().join('-') : null
      msg += ` Se pidieron ${diasPedidos} días pero el histórico guardado tiene ${diasEncontrados}${desdeHist ? ' (empieza el ' + desdeHist + ')' : ''} — no es un error, todavía no se acumuló más historial.`
    }
  }
  box.textContent = msg
}

async function cargarRango(desdeStr, hastaStr) {
  const statusEl = document.getElementById('status')
  statusEl.textContent = 'Cargando rango...'

  const hoyStr = toISO(new Date())
  const incluyeHoy = desdeStr <= hoyStr && hastaStr >= hoyStr
  const hastaHistorico = incluyeHoy ? toISO(new Date(startOfDay(new Date(hoyStr + 'T00:00:00')).getTime() - 86400000)) : hastaStr

  let historico = []
  if (desdeStr <= hastaHistorico) {
    const { data, error } = await supabase
      .from('reportes_ventas_historico')
      .select('fecha, datos')
      .gte('fecha', desdeStr)
      .lte('fecha', hastaHistorico)
      .order('fecha')
    if (error) { statusEl.textContent = 'Error: ' + error.message; return }
    historico = data || []
  }

  let dias = historico
  if (incluyeHoy) {
    const { data: hoyRow, error: errHoy } = await supabase
      .from('reportes_ventas_actual')
      .select('datos')
      .eq('clave', 'hoy')
      .maybeSingle()
    if (errHoy) { statusEl.textContent = 'Error: ' + errHoy.message; return }
    // Si el agente lleva un tiempo apagado, la fila 'hoy' puede haber quedado
    // congelada en un día que ya está en el histórico -- usarla igual (mal
    // etiquetada como "hoy") duplicaría ese día. Solo se usa si de verdad
    // corresponde al día de hoy.
    if (hoyRow && hoyRow.datos.periodo?.hasta === hoyStr) dias = [...historico, { fecha: hoyStr, datos: hoyRow.datos }]
  }

  if (!dias.length) {
    statusEl.textContent = 'Sin reportes guardados en ese rango.'
    renderRangoBanner(0, desdeStr, hastaStr)
    return
  }

  pintar(combinarDias(dias))
  statusEl.textContent = `Rango ${desdeStr} a ${hastaStr} — combinando ${dias.length} día(s)`
  renderRangoBanner(dias.length, desdeStr, hastaStr)
}

// ---------------------------------------------------------------------------
// Carga principal -- lee directo de Supabase, nunca calcula nada acá.
// ---------------------------------------------------------------------------
let ultimoDatos = null

function pintar(datos) {
  ultimoDatos = datos
  renderVivoBanner(datos.datosEnVivo)
  renderKpis(datos)
  renderBarChart(document.getElementById('chartVentas'), datos.ventasDiarias, { money, num })

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

  renderTable('ventasPorCajero',
    [{ label: 'Cajero' }, { label: 'Tickets', num: true }, { label: 'Total', num: true }, { label: 'Ganancia', num: true }],
    datos.ventasPorCajero || [], // reportes ya guardados antes de la Fase D no tienen este campo todavía
    (r) => `<tr><td>${r.cajero}</td><td class="num">${num(r.tickets)}</td><td class="num">${money(r.total)}</td><td class="num">${money(r.gananciaBruta)}</td></tr>`,
    'Sin ventas en este periodo.'
  )

  renderCashflow(datos.flujoCaja)
  renderCuentasInternas(datos.cuentasInternas)

  const stockEmptyMsg = modo === 'rango'
    ? 'No disponible para rangos personalizados (ver aviso arriba).'
    : 'Ningún producto con stock bajo. 🎉'
  document.getElementById('stockCount').textContent = modo === 'rango' ? '—' : datos.stockBajo.length
  renderTable('stockBajo',
    [{ label: 'Producto' }, { label: 'Existencia', num: true }, { label: 'Mínimo', num: true }],
    datos.stockBajo,
    (r) => `<tr class="low-stock-row"><td>${r.descripcion}</td><td class="num">${num(r.existencia)}</td><td class="num">${num(r.minimo)}</td></tr>`,
    stockEmptyMsg
  )
}

async function cargar() {
  if (modo !== 'rango') { document.getElementById('rangoBanner').style.display = 'none' }

  if (modo === 'rango') {
    await cargarRango(rangoDesde, rangoHasta)
    return
  }

  const statusEl = document.getElementById('status')
  statusEl.textContent = 'Cargando...'

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
  if (modo === 'rango') { cargar(); return } // rango personalizado: recombina lo ya guardado, no pide nada al agente

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

// Fecha más antigua real en reportes_ventas_historico -- se usa como piso
// del input "Desde" (para no dejar pedir un rango que ya sabemos vacío) y en
// el mensaje de renderRangoBanner() cuando un rango pedido viene incompleto.
async function cargarFechaMinima() {
  const { data } = await supabase
    .from('reportes_ventas_historico')
    .select('fecha')
    .order('fecha')
    .limit(1)
    .maybeSingle()
  if (data && data.fecha) {
    fechaMinimaHistorico = data.fecha
    document.getElementById('fDesde').min = data.fecha
    document.getElementById('fHasta').min = data.fecha
  }
}

// ---------------------------------------------------------------------------
// Auditoría de compra por marca -- panel aparte, no combina con nada del
// dashboard principal. Botón dispara agente-servidor (lib/auditoriaCompra.js)
// vía auditoria_solicitudes, mismo mecanismo de "solicitud + polling" que ya
// usa solicitarActualizacion(). Ver SERVIDOR.md.
// ---------------------------------------------------------------------------
let auditoriaDatos = null

function abrirAuditoria() {
  document.getElementById('auditoriaOverlay').style.display = 'flex'
}
function cerrarAuditoria() {
  document.getElementById('auditoriaOverlay').style.display = 'none'
}

const AUDITORIA_COLS = [
  { key: 'nombre', label: 'Producto', num: false },
  { key: 'existenciaActual', label: 'Existencia', num: true, fmt: (v) => v === null ? '—' : num(v) },
  { key: 'cantidadVendida90d', label: 'Vend. 90d', num: true, fmt: num },
  { key: 'diasEnCero', label: 'Días $0', num: true, fmt: (v) => dec(v, 1) },
  { key: 'ventaAjustadaMes', label: 'Vta/mes*', num: true, fmt: (v) => v === null ? '—' : dec(v, 2) },
  { key: 'objetivo', label: 'Objetivo', num: true, fmt: (v) => v === null ? '—' : num(v) },
  { key: 'comprar', label: 'Comprar', num: true, fmt: (v) => v === null ? '—' : num(v) },
  { key: 'costoCompra', label: 'Costo', num: true, fmt: (v) => v === null ? '—' : money(v) },
]

function renderAuditoriaTabla(filas) {
  const box = document.getElementById('auditoriaTabla')
  box.innerHTML = ''
  if (!filas.length) { box.appendChild(el('<div class="empty">Sin productos para ese patrón.</div>')); return }

  const conDatos = filas.filter((f) => !f.sinDatosSuficientes)
  const sinDatos = filas.filter((f) => f.sinDatosSuficientes)

  const thead = AUDITORIA_COLS.map((c) => `<th class="${c.num ? 'num' : ''}">${c.label}</th>`).join('') + '<th>Mensual (3×30d)</th>'
  const rows = conDatos.map((f) => {
    const cells = AUDITORIA_COLS.map((c) => {
      const raw = f[c.key]
      const display = c.fmt ? c.fmt(raw) : raw
      return `<td class="${c.num ? 'num' : ''}">${display}</td>`
    }).join('')
    const mensual = (f.mensual || []).map((m) => {
      const g = m.crecimientoPct === null ? '' : ` (${m.crecimientoPct >= 0 ? '▲' : '▼'}${dec(Math.abs(m.crecimientoPct), 1)}%)`
      return `${m.desde.slice(5)}: ${num(m.cantidadVendida)}${g}`
    }).join(' · ')
    return `<tr>${cells}<td class="mensual-cell">${mensual}</td></tr>`
  }).join('')

  const table = el(`<table><thead><tr>${thead}</tr></thead><tbody>${rows}</tbody></table>`)
  box.appendChild(table)

  if (sinDatos.length) {
    box.appendChild(el(`<div class="hint">Sin datos suficientes para proyectar (decidir a mano): ${sinDatos.map((f) => f.nombre).join(', ')}.</div>`))
  }
}

function pintarAuditoria(datos) {
  const box = document.getElementById('auditoriaResultado')
  box.style.display = ''
  const conDatos = datos.filas.filter((f) => !f.sinDatosSuficientes)
  const totalUnidades = conDatos.reduce((s, f) => s + f.comprar, 0)
  const totalCosto = conDatos.reduce((s, f) => s + f.costoCompra, 0)
  document.getElementById('auditoriaTotalUnidades').textContent = num(totalUnidades)
  document.getElementById('auditoriaTotalCosto').textContent = money(totalCosto)
  renderAuditoriaTabla(datos.filas)
}

async function generarAuditoria(e) {
  e.preventDefault()
  const statusEl = document.getElementById('auditoriaStatus')
  const btn = e.target.querySelector('button[type="submit"]')
  const patronInput = document.getElementById('auditoriaPatron').value.trim()
  const meses = Number(document.getElementById('auditoriaMeses').value) || 1
  const crecimiento = Number(document.getElementById('auditoriaCrecimiento').value)
  if (!patronInput) { statusEl.textContent = 'Ingresá una marca o patrón (ej. "FYE").'; return }
  // Mismo criterio que inventario-app (WorkerPage.jsx: ilike(prefijo + '%')):
  // el usuario solo escribe el prefijo de la marca, el '%' se agrega solo si
  // no lo puso ya -- lib/auditoriaCompra.js espera el patrón completo (LIKE
  // exacto, sin wildcard implícito, para que el CLI siga funcionando igual).
  const patron = patronInput.includes('%') ? patronInput : patronInput + '%'

  btn.disabled = true
  document.getElementById('auditoriaResultado').style.display = 'none'
  statusEl.textContent = 'Solicitando a la tienda...'
  try {
    const { data, error } = await supabase
      .from('auditoria_solicitudes')
      .insert({ patron, meses, crecimiento_pct: crecimiento })
      .select('id')
      .single()
    if (error) { statusEl.textContent = 'Error: ' + error.message; return }

    const inicio = Date.now()
    const TIMEOUT_MS = 100000
    while (true) {
      await new Promise((r) => setTimeout(r, 1500))
      const { data: row, error: errRow } = await supabase
        .from('auditoria_solicitudes')
        .select('status, mensaje, datos')
        .eq('id', data.id)
        .maybeSingle()
      if (errRow) { statusEl.textContent = 'Error: ' + errRow.message; return }
      if (row?.status === 'done') {
        auditoriaDatos = { ...row.datos, patron }
        pintarAuditoria(auditoriaDatos)
        statusEl.textContent = row.mensaje || 'Listo.'
        return
      }
      if (row?.status === 'error') { statusEl.textContent = 'Error del agente: ' + (row.mensaje || 'sin detalle'); return }
      if (Date.now() - inicio > TIMEOUT_MS) {
        statusEl.textContent = 'La tienda no respondió a tiempo (¿está abierto el agente en la PC?).'
        return
      }
      statusEl.textContent = row?.status === 'running' ? 'Calculando en la tienda...' : 'Esperando que el agente tome la solicitud...'
    }
  } finally {
    btn.disabled = false
  }
}

async function exportarAuditoria() {
  if (!auditoriaDatos) return
  const btn = document.getElementById('btnExportarAuditoria')
  btn.disabled = true
  try {
    const { exportarAuditoriaExcel } = await import('./lib/exportarAuditoriaExcel.js')
    await exportarAuditoriaExcel(auditoriaDatos)
  } catch (err) {
    document.getElementById('auditoriaStatus').textContent = 'No se pudo exportar: ' + err.message
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
  document.getElementById('btnAuditoria').addEventListener('click', abrirAuditoria)
  document.getElementById('btnCerrarAuditoria').addEventListener('click', cerrarAuditoria)
  document.getElementById('auditoriaOverlay').addEventListener('click', (e) => {
    if (e.target.id === 'auditoriaOverlay') cerrarAuditoria()
  })
  document.getElementById('auditoriaForm').addEventListener('submit', generarAuditoria)
  document.getElementById('btnExportarAuditoria').addEventListener('click', exportarAuditoria)
  document.getElementById('rangoForm').addEventListener('submit', (e) => {
    e.preventDefault()
    const statusEl = document.getElementById('status')
    const desde = document.getElementById('fDesde').value
    const hasta = document.getElementById('fHasta').value
    if (!desde || !hasta) { statusEl.textContent = 'Elegí ambas fechas ("Desde" y "Hasta").'; return }
    if (desde > hasta) { statusEl.textContent = 'La fecha "Desde" no puede ser posterior a "Hasta".'; return }
    modo = 'rango'
    chipActivo = null // rango manual -- ningún chip de arriba queda resaltado
    rangoDesde = desde
    rangoHasta = hasta
    markActiveQuick()
    cargar()
  })
  document.getElementById('filtroProducto').addEventListener('input', renderRotacion)
  document.getElementById('filtroDepto').addEventListener('change', renderRotacion)
  document.getElementById('btnToggleInternas').addEventListener('click', () => {
    internasVisibles = !internasVisibles
    renderCuentasInternas(ultimoDatos && ultimoDatos.cuentasInternas)
  })

  cargarFechaMinima()
  cargarTendencia()
  cargarSalud()
  cargar()
}

iniciarGate()
