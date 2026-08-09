import { createClient } from '@supabase/supabase-js'
import { renderBarChart, renderLineChart, renderMargenChart, renderAuditoriaTendenciaChart } from './chart.js'

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
  document.getElementById('appRoot').style.display = 'flex'
  initApp()
}

// Borra la sesión cacheada y vuelve a pedir la clave -- para cuando alguien
// quiera cerrar sesión sin tener que cerrar el navegador entero (2026-08-08).
function cerrarSesion() {
  sessionStorage.removeItem(SESION_KEY)
  supabase = null
  document.getElementById('appRoot').style.display = 'none'
  document.getElementById('gate').style.display = 'flex'
  document.getElementById('gateClave').value = ''
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
// mostrando solo el día de hoy.
let claveActual = 'mes';
let modo = 'rapido'; // 'rapido' (reportes_ventas_actual) | 'rango' (fDesde/fHasta o "últimos N días", combina reportes_ventas_historico)
let chipActivo = 'mes' // clave del chip resaltado arriba, o null si el rango activo vino del formulario manual
let rangoDesde = null
let rangoHasta = null
let fechaMinimaHistorico = null // más vieja fecha real guardada en reportes_ventas_historico
let rotacionData = []
let sortState = { key: 'ingreso', dir: -1 }
// Paginación de "Rotación de productos" (2026-08-09) -- antes se
// renderizaban todas las filas al DOM de una. No era un problema real con
// el catálogo actual (~2.900 productos como mucho), pero quedaba frágil
// para cuando el catálogo creciera bastante más -- ver auditoría original.
const FILAS_POR_PAGINA = 100
let paginaRotacion = 1
// Al imprimir hay que mostrar la tabla completa, no solo la página actual
// en pantalla -- ver window.onbeforeprint/onafterprint en initApp().
let imprimiendoRotacion = false

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
// Meta de venta mensual -- editable, solo tiene sentido viendo "Este mes"
// (comparar contra un objetivo mensual en cualquier otro rango no significa
// nada). El progreso se recalcula contra datos.resumen.total de lo que ya
// esté pintado, nunca pide nada aparte a Supabase.
// ---------------------------------------------------------------------------
let metaVentaMonto = null

function mesActualKey() {
  const d = new Date()
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0')
}

async function cargarMetaVenta() {
  const { data } = await supabase.from('metas_venta').select('monto').eq('mes', mesActualKey()).maybeSingle()
  metaVentaMonto = data ? Number(data.monto) : null
}

async function guardarMetaVenta(monto) {
  const { error } = await supabase.from('metas_venta').upsert({ mes: mesActualKey(), monto, actualizado_en: new Date().toISOString() }, { onConflict: 'mes' })
  if (error) { alert('No se pudo guardar la meta: ' + error.message); return }
  metaVentaMonto = monto
  if (ultimoDatos) renderMetaVenta(ultimoDatos)
}

// Proyección de fin de mes (2026-08-09, pedido explícito del usuario) --
// "a este ritmo, ¿cuánto voy a vender este mes?", independiente de si hay
// una meta cargada o no. Simple: total de lo que va del mes, dividido por
// los días ya transcurridos (hoy cuenta entero, aunque el día no haya
// terminado -- mismo criterio que usa el resto del sitio para "hoy"),
// multiplicado por los días totales del mes.
function proyeccionFinDeMes(totalActual) {
  const hoy = new Date()
  const diasTranscurridos = hoy.getDate()
  const diasDelMes = new Date(hoy.getFullYear(), hoy.getMonth() + 1, 0).getDate()
  if (diasTranscurridos <= 0) return null
  return { proyeccion: (totalActual / diasTranscurridos) * diasDelMes, diasTranscurridos, diasDelMes }
}

function renderMetaVenta(datos) {
  const card = document.getElementById('metaVentaCard')
  const body = document.getElementById('metaVentaBody')
  const esEsteMes = modo === 'rapido' && claveActual === 'mes'
  if (!esEsteMes) { card.style.display = 'none'; return }
  card.style.display = ''
  body.innerHTML = ''

  const actual = datos.resumen.total
  const proy = proyeccionFinDeMes(actual)
  const proyeccionHtml = proy ? `
    <div class="meta-venta-proyeccion">
      Al ritmo de estos ${proy.diasTranscurridos} días, vas a terminar el mes en aprox. <b>${money(proy.proyeccion)}</b>
      ${metaVentaMonto !== null ? (proy.proyeccion >= metaVentaMonto
        ? ' — <span class="kpi-up">alcanzarías la meta ✓</span>'
        : ` — <span class="kpi-down">quedarías ${money(metaVentaMonto - proy.proyeccion)} corto de la meta</span>`) : ''}
    </div>
  ` : ''

  if (metaVentaMonto === null) {
    body.appendChild(el(`
      <div>
        ${proyeccionHtml}
        <div class="meta-venta-form">
          <input type="number" id="metaVentaInput" placeholder="Ej: 8000000" min="0" step="1">
          <button id="btnGuardarMeta" class="btn btn-primary btn-sm">Guardar meta de ${new Date().toLocaleDateString('es-CL', { month: 'long' })}</button>
        </div>
      </div>
    `))
    document.getElementById('btnGuardarMeta').addEventListener('click', () => {
      const v = Number(document.getElementById('metaVentaInput').value)
      if (!v || v <= 0) { alert('Ingresá un monto válido.'); return }
      guardarMetaVenta(v)
    })
    return
  }

  const pctAvance = metaVentaMonto > 0 ? Math.min(100, (actual / metaVentaMonto) * 100) : 0
  const falta = Math.max(0, metaVentaMonto - actual)
  body.appendChild(el(`
    <div class="meta-venta-progreso">
      <div class="meta-venta-cifras">
        <span>${money(actual)} de ${money(metaVentaMonto)}</span>
        <span class="meta-venta-pct">${dec(pctAvance, 1)}%</span>
      </div>
      <div class="meta-venta-barra"><div class="meta-venta-barra-fill" style="width:${pctAvance}%"></div></div>
      <div class="meta-venta-falta">${falta > 0 ? `Faltan ${money(falta)} para llegar a la meta.` : '¡Meta alcanzada! 🎉'}</div>
      ${proyeccionHtml}
      <button id="btnEditarMeta" class="btn btn-outline btn-sm" style="margin-top:8px;">Editar meta</button>
    </div>
  `))
  document.getElementById('btnEditarMeta').addEventListener('click', () => { metaVentaMonto = null; renderMetaVenta(datos) })
}

// ---------------------------------------------------------------------------
// Tendencia histórica -- todo reportes_ventas_historico, independiente del
// periodo seleccionado arriba.
// ---------------------------------------------------------------------------
async function cargarTendencia() {
  const box = document.getElementById('chartTendencia')
  const boxMargen = document.getElementById('chartMargen')
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
  renderMargenChart(boxMargen, data || [], { pct })
}

// ---------------------------------------------------------------------------
// Salud del agente -- heartbeat independiente de si alguien pidió un
// reporte. Se revisa una vez al abrir el sitio.
// ---------------------------------------------------------------------------
async function cargarSalud() {
  const box = document.getElementById('agenteBanner')
  const { data, error } = await supabase.from('agente_estado').select('ultimo_latido').eq('id', 1).maybeSingle()
  if (error || !data) { box.style.display = 'none'; agenteCaidoInfo = null; return }
  const ultimo = new Date(data.ultimo_latido)
  const minutos = Math.round((Date.now() - ultimo.getTime()) / 60000)
  if (minutos > 45) {
    box.style.display = 'flex'
    box.innerHTML = `⚠ El agente de la tienda no responde hace ${minutos} min (último aviso: ${ultimo.toLocaleString('es-CL')}). Revisar que la PC de la tienda y el agente sigan encendidos.`
    agenteCaidoInfo = { minutos }
  } else {
    box.style.display = 'none'
    agenteCaidoInfo = null
  }
  // cargarSalud() corre aparte de cargar() (no espera a que termine) -- si
  // los datos principales ya se habían pintado antes de que esto resolviera,
  // hay que volver a armar el panel de alertas para que lo incluya.
  if (ultimoDatos) renderAlertasPanel(ultimoDatos, (ultimoDatos.rotacionProductos || []).filter((p) => p.margenPct < 0), modo === 'rango')
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

  const totalPaginas = Math.max(1, Math.ceil(filas.length / FILAS_POR_PAGINA))
  if (paginaRotacion > totalPaginas) paginaRotacion = totalPaginas
  const inicio = (paginaRotacion - 1) * FILAS_POR_PAGINA
  const filasPagina = imprimiendoRotacion ? filas : filas.slice(inicio, inicio + FILAS_POR_PAGINA)

  const thead = ROTACION_COLS.map((c) => {
    const arrow = sortState.key === c.key ? (sortState.dir === 1 ? '▲' : '▼') : ''
    return `<th class="sortable ${c.num ? 'num' : ''}" data-key="${c.key}">${c.label}<span class="arrow">${arrow}</span></th>`
  }).join('') + '<th></th>'

  const rows = filasPagina.map((p) => {
    const cells = ROTACION_COLS.map((c) => {
      if (c.key === 'clasificacionABC') {
        return `<td><span class="abc-badge abc-${p.clasificacionABC.toLowerCase()}">${p.clasificacionABC}</span></td>`
      }
      const raw = p[c.key]
      const display = c.fmt ? c.fmt(raw) : raw
      const tag = c.key === 'nombre' && p.estimado ? '<span class="badge-soft" title="Incluye ventas de hoy estimadas del log, todavía no confirmadas por un respaldo">HOY: EST.</span>' : ''
      return `<td class="${c.num ? 'num' : ''}">${display}${tag}</td>`
    }).join('')
    const btnHistorial = imprimiendoRotacion ? '' : `<td><button class="btn btn-ghost btn-sm" data-historial-codigo="${p.codigo}" data-historial-nombre="${p.nombre.replace(/"/g, '&quot;')}">📈 Histórico</button></td>`
    return `<tr>${cells}${btnHistorial}</tr>`
  }).join('')

  const table = el(`<table><thead><tr>${thead}</tr></thead><tbody>${rows}</tbody></table>`)
  table.querySelectorAll('th.sortable').forEach((th) => {
    th.addEventListener('click', () => {
      const key = th.dataset.key
      if (sortState.key === key) sortState.dir *= -1
      else sortState = { key, dir: -1 }
      paginaRotacion = 1
      renderRotacion()
    })
  })
  table.querySelector('tbody').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-historial-codigo]')
    if (btn) abrirHistorial(btn.dataset.historialCodigo, btn.dataset.historialNombre)
  })
  box.appendChild(table)

  if (totalPaginas > 1 && !imprimiendoRotacion) {
    const paginador = el(`
      <div class="paginador">
        <button class="btn btn-outline btn-sm" data-accion="prev" ${paginaRotacion <= 1 ? 'disabled' : ''}>← Anterior</button>
        <span class="hint-header" style="margin: 0 8px;">Página ${paginaRotacion} de ${totalPaginas} (${num(filas.length)} productos)</span>
        <button class="btn btn-outline btn-sm" data-accion="next" ${paginaRotacion >= totalPaginas ? 'disabled' : ''}>Siguiente →</button>
      </div>
    `)
    paginador.querySelector('[data-accion="prev"]').addEventListener('click', () => { paginaRotacion -= 1; renderRotacion() })
    paginador.querySelector('[data-accion="next"]').addEventListener('click', () => { paginaRotacion += 1; renderRotacion() })
    box.appendChild(paginador)
  }
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
// Cuentas internas (forma_pago "Crédito").
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
// Comparativo interanual -- este periodo vs. el mismo periodo, un año antes.
// ---------------------------------------------------------------------------
function renderComparativoInteranual(cmp) {
  const box = document.getElementById('comparativoInteranual')
  box.innerHTML = ''
  if (!cmp) {
    box.appendChild(el('<div class="empty">No disponible para rangos personalizados -- usá los rangos rápidos de arriba.</div>'))
    return
  }
  if (cmp.sinDatosPrevios) {
    // El POS solo tiene montos reales cargados desde marzo de 2026 -- antes
    // de eso los tickets existen (se cuentan) pero total/subtotal quedaron
    // en $0 en la base, no es que el negocio haya vendido cero. Mensaje
    // distinto según la causa, para no dar a entender que la tienda no
    // vendió nada esos días (confirmado real 2026-08-09).
    const esHuecoDeDatosViejos = cmp.periodoAnteriorDesde < '2026-03-01'
    const motivo = esHuecoDeDatosViejos
      ? 'el POS no tiene montos cargados para fechas tan antiguas (recién a partir de marzo de 2026 el sistema empezó a registrar el total de cada venta) -- no significa que no se haya vendido nada esos días.'
      : 'todavía no hay un cierre guardado para ese periodo.'
    box.appendChild(el(`<div class="empty">Sin comparación confiable contra ${cmp.periodoAnteriorDesde} al ${cmp.periodoAnteriorHasta}: ${motivo}</div>`))
    return
  }
  const cards = [
    { label: 'Ventas', value: money(cmp.actual.total), sub: compareSub(cmp.actual.total, cmp.previo.total) },
    { label: 'Ganancia bruta', value: money(cmp.actual.gananciaBruta), sub: compareSub(cmp.actual.gananciaBruta, cmp.previo.gananciaBruta) },
    { label: 'Tickets', value: num(cmp.actual.tickets), sub: compareSub(cmp.actual.tickets, cmp.previo.tickets) },
  ]
  const grid = el('<div class="kpis"></div>')
  cards.forEach((c) => grid.appendChild(el(`
    <div class="kpi-card">
      <div class="kpi-label">${c.label}</div>
      <div class="kpi-value">${c.value}</div>
      ${c.sub || ''}
    </div>
  `)))
  box.appendChild(grid)
  box.appendChild(el(`<p class="hint-header" style="padding: 8px 0 0;">Comparado contra ${cmp.periodoAnteriorDesde} a ${cmp.periodoAnteriorHasta}.</p>`))
}

// ---------------------------------------------------------------------------
// Devoluciones y anulaciones -- oculto detrás de un botón, no es para
// mirar todos los días (mismo patrón que Cuentas internas).
// ---------------------------------------------------------------------------
let devolucionesVisibles = false

function renderDevoluciones(devoluciones) {
  const btn = document.getElementById('btnToggleDevoluciones')
  const boxResumen = document.getElementById('devolucionesResumen')
  const boxDetalle = document.getElementById('devolucionesDetalle')

  const datos = devoluciones || { ticketsAnulados: [], lineasDevueltas: [], totalAnulado: 0, totalDevuelto: 0 }
  const totalMovimientos = datos.ticketsAnulados.length + datos.lineasDevueltas.length
  btn.textContent = `${devolucionesVisibles ? 'Ocultar' : 'Ver detalle'} (${totalMovimientos}, ${money(datos.totalAnulado + datos.totalDevuelto)})`

  boxResumen.style.display = devolucionesVisibles ? '' : 'none'
  boxDetalle.style.display = devolucionesVisibles ? '' : 'none'
  if (!devolucionesVisibles) return

  renderTable('devolucionesResumen',
    [{ label: 'Concepto' }, { label: 'Cantidad', num: true }, { label: 'Total', num: true }],
    [
      { concepto: 'Tickets anulados', cantidad: datos.ticketsAnulados.length, total: datos.totalAnulado },
      { concepto: 'Líneas devueltas', cantidad: datos.lineasDevueltas.length, total: datos.totalDevuelto },
    ],
    (r) => `<tr><td>${r.concepto}</td><td class="num">${num(r.cantidad)}</td><td class="num">${money(r.total)}</td></tr>`,
    'Sin movimientos en este periodo.'
  )

  const filasDetalle = [
    ...datos.ticketsAnulados.map((t) => ({ tipo: 'Ticket anulado', vendidoEn: t.vendidoEn, cajero: t.cajero, detalle: `Folio ${t.folio}`, monto: t.total })),
    ...datos.lineasDevueltas.map((l) => ({ tipo: l.devolucionTotal ? 'Devolución total' : 'Devolución parcial', vendidoEn: l.vendidoEn, cajero: l.cajero, detalle: `${l.nombre} ×${dec(l.cantidadDevuelta, 2)}`, monto: l.montoDevuelto })),
  ].sort((a, b) => new Date(b.vendidoEn) - new Date(a.vendidoEn))

  renderTable('devolucionesDetalle',
    [{ label: 'Tipo' }, { label: 'Fecha' }, { label: 'Cajero' }, { label: 'Detalle' }, { label: 'Monto', num: true }],
    filasDetalle,
    (f) => `<tr><td>${f.tipo}</td><td>${new Date(f.vendidoEn).toLocaleString('es-CL')}</td><td>${f.cajero}</td><td>${f.detalle}</td><td class="num">${money(f.monto)}</td></tr>`,
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
  box.innerHTML = `⚡ Incluye <b>${info.ticketsEnVivo}</b> venta(s) de hoy en vivo, reconstruidas directamente del registro del POS (todavía sin confirmar por un respaldo). Base de datos actualizada hasta ${desde}. El detalle por producto de esas ventas es una estimación (marcado <span class="badge-soft">HOY: EST.</span>).`
}

// ---------------------------------------------------------------------------
// Rango personalizado -- combina N días de reportes_ventas_historico
// client-side.
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

// dias: [{ fecha, datos }] ascendente por fecha.
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
      if (p.existencia !== null) cur.existencia = p.existencia
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
    for (const c of datos.ventasPorCajero || []) {
      const cur = porCajero.get(c.cajero) || { cajero: c.cajero, tickets: 0, total: 0, gananciaBruta: 0 }
      cur.tickets += c.tickets; cur.total += c.total; cur.gananciaBruta += c.gananciaBruta
      porCajero.set(c.cajero, cur)
    }
  }
  const ventasPorCajero = [...porCajero.values()]
    .map((c) => ({ ...c, ticketPromedio: c.tickets > 0 ? c.total / c.tickets : 0 }))
    .sort((a, b) => b.total - a.total)

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

  const ticketsAnulados = dias.flatMap((d) => (d.datos.devoluciones || {}).ticketsAnulados || [])
  const lineasDevueltas = dias.flatMap((d) => (d.datos.devoluciones || {}).lineasDevueltas || [])
  const devoluciones = {
    ticketsAnulados: ticketsAnulados.sort((a, b) => new Date(b.vendidoEn) - new Date(a.vendidoEn)),
    lineasDevueltas: lineasDevueltas.sort((a, b) => new Date(b.vendidoEn) - new Date(a.vendidoEn)),
    totalAnulado: ticketsAnulados.reduce((s, t) => s + t.total, 0),
    totalDevuelto: lineasDevueltas.reduce((s, l) => s + l.montoDevuelto, 0),
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
    stockMuerto: [],
    flujoCaja,
    cuentasInternas,
    devoluciones,
    // No es sumable entre días de forma sensata (es una comparación de
    // periodo, no una métrica aditiva) -- se oculta en la UI para rango
    // personalizado, mismo criterio que ya usa resumenAnterior/stockBajo.
    comparativoInteranual: null,
  }
}

// Mensaje del banner de rango personalizado.
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
// Productos con margen negativo (2026-08-09) -- calculado client-side de lo
// que ya viene en rotacionProductos, no pide nada aparte.
// ---------------------------------------------------------------------------
function renderMargenNegativo(productos) {
  const perdiendo = (productos || []).filter((p) => p.margenPct < 0).sort((a, b) => a.margenPct - b.margenPct)
  document.getElementById('margenNegativoCount').textContent = perdiendo.length
  renderTable('margenNegativo',
    [{ label: 'Producto' }, { label: 'Cant.', num: true }, { label: 'Ingreso', num: true }, { label: 'Costo', num: true }, { label: 'Pérdida', num: true }, { label: 'Margen %', num: true }],
    perdiendo,
    (p) => `<tr class="low-stock-row"><td>${p.nombre}</td><td class="num">${num(p.cantidad)}</td><td class="num">${money(p.ingreso)}</td><td class="num">${money(p.costo)}</td><td class="num">${money(Math.abs(p.gananciaBruta))}</td><td class="num">${pct(p.margenPct)}</td></tr>`,
    'Ningún producto con margen negativo en este periodo. 🎉'
  )
  return perdiendo
}

// ---------------------------------------------------------------------------
// Stock muerto -- viene calculado del backend (stats.js::stockMuerto()),
// como stockBajo: una foto del momento, no aplica a rangos personalizados.
// ---------------------------------------------------------------------------
function renderStockMuerto(stockMuerto, esRango) {
  const lista = stockMuerto || []
  document.getElementById('stockMuertoCount').textContent = esRango ? '—' : lista.length
  const emptyMsg = esRango
    ? 'No disponible para rangos personalizados (es una foto del momento).'
    : 'Ningún producto con stock parado hace 90+ días. 🎉'
  renderTable('stockMuerto',
    [{ label: 'Producto' }, { label: 'Departamento' }, { label: 'Existencia', num: true }, { label: 'Capital inmovilizado', num: true }],
    lista,
    (p) => `<tr><td>${p.descripcion}</td><td>${p.departamento || '—'}</td><td class="num">${num(p.existencia)}</td><td class="num">${money(p.capitalInmovilizado)}</td></tr>`,
    emptyMsg
  )
}

// ---------------------------------------------------------------------------
// Panel de alertas consolidado -- "qué necesita mi atención", sin tener que
// bajar por toda la página. Se arma DESPUÉS de pintar el resto (reusa lo ya
// calculado: margen negativo, stock bajo/muerto, meta, salud del agente).
// ---------------------------------------------------------------------------
let agenteCaidoInfo = null // lo llena cargarSalud()

function renderAlertasPanel(datos, margenNegativoLista, esRango) {
  const panel = document.getElementById('alertasPanel')
  const body = document.getElementById('alertasPanelBody')
  const chips = []

  if (agenteCaidoInfo) {
    chips.push({ tipo: 'error', texto: `⚠ El agente de la tienda no responde hace ${agenteCaidoInfo.minutos} min`, ancla: null })
  }
  if (!esRango && (datos.stockBajo || []).length > 0) {
    chips.push({ tipo: 'alerta', texto: `${datos.stockBajo.length} producto(s) con stock bajo`, ancla: 'stockBajo' })
  }
  if ((margenNegativoLista || []).length > 0) {
    chips.push({ tipo: 'alerta', texto: `${margenNegativoLista.length} producto(s) con margen negativo`, ancla: 'margenNegativoCard' })
  }
  if (!esRango && (datos.stockMuerto || []).length > 0) {
    const capital = datos.stockMuerto.reduce((s, p) => s + p.capitalInmovilizado, 0)
    chips.push({ tipo: 'info', texto: `${datos.stockMuerto.length} producto(s) sin vender hace 90+ días (${money(capital)} inmovilizados)`, ancla: 'stockMuertoCard' })
  }
  if (modo === 'rapido' && claveActual === 'mes' && metaVentaMonto !== null) {
    const proy = proyeccionFinDeMes(datos.resumen.total)
    if (proy && proy.proyeccion < metaVentaMonto) {
      chips.push({ tipo: 'alerta', texto: `Al ritmo actual, quedarías ${money(metaVentaMonto - proy.proyeccion)} corto de la meta del mes`, ancla: 'metaVentaCard' })
    }
  }

  if (!chips.length) { panel.style.display = 'none'; return }
  panel.style.display = ''
  body.innerHTML = ''
  chips.forEach((c) => {
    const chip = el(`<div class="alerta-chip alerta-chip-${c.tipo}">${c.texto}</div>`)
    if (c.ancla) {
      chip.style.cursor = 'pointer'
      chip.addEventListener('click', () => document.getElementById(c.ancla)?.scrollIntoView({ behavior: 'smooth', block: 'center' }))
    }
    body.appendChild(chip)
  })
}

// ---------------------------------------------------------------------------
// Carga principal -- lee directo de Supabase, nunca calcula nada acá.
// ---------------------------------------------------------------------------
let ultimoDatos = null

function pintar(datos) {
  ultimoDatos = datos
  renderVivoBanner(datos.datosEnVivo)
  renderKpis(datos)
  renderComparativoInteranual(datos.comparativoInteranual)
  renderDevoluciones(datos.devoluciones)
  renderMetaVenta(datos)
  renderBarChart(document.getElementById('chartVentas'), datos.ventasDiarias, { money, num })

  rotacionData = datos.rotacionProductos
  paginaRotacion = 1
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
    [{ label: 'Cajero' }, { label: 'Tickets', num: true }, { label: 'Total', num: true }, { label: 'Ticket prom.', num: true }, { label: 'Ganancia', num: true }],
    datos.ventasPorCajero || [],
    (r) => `<tr><td>${r.cajero}</td><td class="num">${num(r.tickets)}</td><td class="num">${money(r.total)}</td><td class="num">${money(r.ticketPromedio || 0)}</td><td class="num">${money(r.gananciaBruta)}</td></tr>`,
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

  const margenNegativoLista = renderMargenNegativo(datos.rotacionProductos)
  renderStockMuerto(datos.stockMuerto, modo === 'rango')
  renderAlertasPanel(datos, margenNegativoLista, modo === 'rango')
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
// Exportar el dashboard completo a Excel -- usa lo ya cargado en memoria
// (ultimoDatos), no vuelve a pedir nada a Supabase.
// ---------------------------------------------------------------------------
async function exportarDashboard() {
  const statusEl = document.getElementById('status')
  if (!ultimoDatos) { statusEl.textContent = 'Todavía no hay datos cargados para exportar.'; return }
  const btn = document.getElementById('btnExportarDashboard')
  btn.disabled = true
  try {
    const { exportarDashboardExcel } = await import('./lib/exportarDashboardExcel.js')
    await exportarDashboardExcel(ultimoDatos, { modoRango: modo === 'rango' })
  } catch (err) {
    statusEl.textContent = 'No se pudo exportar: ' + err.message
  } finally {
    btn.disabled = false
  }
}

// ---------------------------------------------------------------------------
// Actualizar ahora -- inserta una fila en reportes_solicitudes y espera a
// que el agente la procese antes de releer los datos frescos.
// ---------------------------------------------------------------------------
async function solicitarActualizacion() {
  if (modo === 'rango') { cargar(); return }

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

// Fecha más antigua real en reportes_ventas_historico.
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
// Alertas de reposición anticipada -- "qué se va a quedar sin stock pronto,
// según su ritmo de venta" para todo el catálogo, y qué convendría cargar
// como inventario mínimo en el POS. Mismo mecanismo de "solicitud +
// polling" que auditoría de compra, pero recorre el catálogo completo
// (agente-servidor/lib/alertasReposicion.js) -- tarda ~1 minuto en
// producción, por eso el timeout es más largo acá que en el resto.
// ---------------------------------------------------------------------------
let alertasFilas = []

function abrirAlertas() {
  document.getElementById('alertasOverlay').style.display = 'flex'
}
function cerrarAlertas() {
  document.getElementById('alertasOverlay').style.display = 'none'
}

const ALERTAS_COLS = [
  { key: 'nombre', label: 'Producto', num: false },
  { key: 'existenciaActual', label: 'Existencia', num: true, fmt: num },
  { key: 'diasHastaAgotarse', label: 'Días hasta agotarse', num: true, fmt: (v) => v <= 0 ? 'Agotado' : dec(v, 1) },
  { key: 'minimoSugerido', label: 'Mínimo sugerido', num: true, fmt: num },
  { key: 'comprarAhora', label: 'Comprar ahora', num: true, fmt: num },
  { key: 'costoCompraAhora', label: 'Costo', num: true, fmt: (v, f) => f.pcosto ? money(v) : 'sin costo' },
]

function renderAlertasTabla() {
  const box = document.getElementById('alertasTabla')
  const texto = document.getElementById('filtroAlertas').value.trim().toLowerCase()
  const filas = alertasFilas.filter((f) => !texto || f.nombre.toLowerCase().includes(texto) || f.codigo.toLowerCase().includes(texto))

  box.innerHTML = ''
  if (!alertasFilas.length) {
    box.appendChild(el('<div class="empty">Todavía no se calculó nada -- apretá "Calcular ahora" (tarda ~1 minuto, recorre todo el catálogo).</div>'))
    return
  }
  if (!filas.length) { box.appendChild(el('<div class="empty">Ningún producto coincide con la búsqueda.</div>')); return }

  const thead = ALERTAS_COLS.map((c) => `<th class="${c.num ? 'num' : ''}">${c.label}</th>`).join('')
  const rows = filas.map((f) => {
    const cells = ALERTAS_COLS.map((c) => {
      const raw = f[c.key]
      const display = c.fmt ? c.fmt(raw, f) : raw
      const urgente = c.key === 'diasHastaAgotarse' && f.diasHastaAgotarse <= 0 ? ' style="color:var(--alert-error);font-weight:700"' : ''
      return `<td class="${c.num ? 'num' : ''}"${urgente}>${display}</td>`
    }).join('')
    return `<tr>${cells}</tr>`
  }).join('')

  box.appendChild(el(`<table><thead><tr>${thead}</tr></thead><tbody>${rows}</tbody></table>`))
}

function pintarAlertas(datos, cuando) {
  alertasFilas = datos.filas
  document.getElementById('alertasStatus').textContent = `${datos.filas.length} producto(s) en riesgo (anticipación ${datos.diasAnticipacion} días) -- calculado ${cuando}`
  renderAlertasTabla()
}

// Trae el último resultado ya calculado (si hay uno) al abrir el sitio, sin
// forzar un cálculo nuevo de 1 minuto solo por mirar la página.
async function cargarUltimaAlerta() {
  const { data } = await supabase
    .from('alertas_reposicion_solicitudes')
    .select('datos, completado_en')
    .eq('status', 'done')
    .order('completado_en', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (data && data.datos) {
    pintarAlertas(data.datos, new Date(data.completado_en).toLocaleString('es-CL'))
  } else {
    document.getElementById('alertasStatus').textContent = 'Todavía no se calculó nunca.'
  }
}

async function calcularAlertas() {
  const statusEl = document.getElementById('alertasStatus')
  const btn = document.getElementById('btnCalcularAlertas')
  const dias = Number(document.getElementById('alertasDias').value) || 14
  btn.disabled = true
  statusEl.textContent = 'Solicitando a la tienda (esto recorre todo el catálogo, puede tardar ~1 minuto)...'
  try {
    const { data, error } = await supabase
      .from('alertas_reposicion_solicitudes')
      .insert({ dias_anticipacion: dias })
      .select('id')
      .single()
    if (error) { statusEl.textContent = 'Error: ' + error.message; return }

    const inicio = Date.now()
    const TIMEOUT_MS = 150000
    while (true) {
      await new Promise((r) => setTimeout(r, 2000))
      const { data: row, error: errRow } = await supabase
        .from('alertas_reposicion_solicitudes')
        .select('status, mensaje, datos, completado_en')
        .eq('id', data.id)
        .maybeSingle()
      if (errRow) { statusEl.textContent = 'Error: ' + errRow.message; return }
      if (row?.status === 'done') {
        pintarAlertas(row.datos, new Date(row.completado_en).toLocaleString('es-CL'))
        return
      }
      if (row?.status === 'error') { statusEl.textContent = 'Error del agente: ' + (row.mensaje || 'sin detalle'); return }
      if (Date.now() - inicio > TIMEOUT_MS) {
        statusEl.textContent = 'La tienda no respondió a tiempo (¿está abierto el agente en la PC?).'
        return
      }
      statusEl.textContent = row?.status === 'running'
        ? 'Calculando en la tienda (recorre todo el catálogo, puede tardar ~1 minuto)...'
        : 'Esperando que el agente tome la solicitud...'
    }
  } finally {
    btn.disabled = false
  }
}

// ---------------------------------------------------------------------------
// Auditoría de compra por marca.
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
  { key: 'calzaConActual', label: 'Inventario confiable', num: false, fmt: (v) => v === null ? '—' : (v ? 'Sí' : 'No') },
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

  const thead = AUDITORIA_COLS.map((c) => `<th class="${c.num ? 'num' : ''}">${c.label}</th>`).join('') + '<th>Mensual (3×30d)</th>'
  const rows = filas.map((f) => {
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

  box.appendChild(el(`<table><thead><tr>${thead}</tr></thead><tbody>${rows}</tbody></table>`))
}

function mesBucketLabel(desdeStr, hastaStr) {
  const d1 = new Date(desdeStr + 'T00:00:00')
  const d2 = new Date(hastaStr + 'T00:00:00')
  const mid = new Date((d1.getTime() + d2.getTime()) / 2)
  const s = mid.toLocaleDateString('es-CL', { month: 'long' })
  return s.charAt(0).toUpperCase() + s.slice(1)
}

function calcularTendenciaAgregada(filas) {
  if (!filas.length || !filas[0].mensual || !filas[0].mensual.length) return { buckets: [], headline: null }

  const nBuckets = filas[0].mensual.length
  const buckets = []
  for (let i = 0; i < nBuckets; i++) {
    const desde = filas[0].mensual[i].desde
    const hasta = filas[0].mensual[i].hasta
    const cantidad = filas.reduce((s, f) => s + ((f.mensual[i] && f.mensual[i].cantidadVendida) || 0), 0)
    buckets.push({ desde, hasta, cantidad })
  }
  for (let i = 1; i < buckets.length; i++) {
    const actual = buckets[i].cantidad, anterior = buckets[i - 1].cantidad
    buckets[i].crecimientoPct = anterior === 0 ? null : +(((actual - anterior) / anterior) * 100).toFixed(1)
  }

  const primero = buckets[0].cantidad, ultimo = buckets[buckets.length - 1].cantidad
  let headline
  if (primero > 0) {
    const pct = ((ultimo - primero) / primero) * 100
    headline = {
      texto: `${pct >= 0 ? '▲ +' : '▼ '}${dec(Math.abs(pct), 1)}% vs. hace ${nBuckets - 1} mes(es)`,
      clase: pct >= 0 ? 'kpi-up' : 'kpi-down',
    }
  } else if (ultimo > 0) {
    headline = { texto: '▲ Empezó a venderse en el último mes', clase: 'kpi-up' }
  } else {
    headline = { texto: 'Sin ventas en los últimos 90 días', clase: '' }
  }
  return { buckets, headline }
}

function renderAuditoriaKpis(datos) {
  const box = document.getElementById('auditoriaKpis')
  box.innerHTML = ''
  const comprables = datos.filas.filter((f) => !f.sinDatosSuficientes && f.comprar > 0)
  const totalUnidades = comprables.reduce((s, f) => s + f.comprar, 0)
  const totalCosto = comprables.reduce((s, f) => s + f.costoCompra, 0)
  const revisar = datos.filas.filter((f) => f.sinDatosSuficientes || f.calzaConActual === false)
  const cards = [
    { label: 'Productos analizados', value: num(datos.filas.length) },
    { label: 'Unidades a comprar', value: num(totalUnidades) },
    { label: 'Inversión estimada', value: money(totalCosto) },
    { label: 'A revisar a mano', value: num(revisar.length) },
  ]
  cards.forEach((c) => box.appendChild(el(`<div class="kpi-card"><div class="kpi-label">${c.label}</div><div class="kpi-value">${c.value}</div></div>`)))
}

function tendenciaBadge(f) {
  const mensual = f.mensual || []
  const last = mensual[mensual.length - 1]
  const pct = last ? last.crecimientoPct : null
  if (pct === null || pct === undefined) return `<span class="tendencia-badge flat">— Sin datos</span>`
  if (pct > 5) return `<span class="tendencia-badge up">▲ +${dec(pct, 1)}%</span>`
  if (pct < -5) return `<span class="tendencia-badge down">▼ ${dec(pct, 1)}%</span>`
  return `<span class="tendencia-badge flat">→ Estable</span>`
}

function renderAuditoriaComprarLista(filas) {
  const comprables = filas.filter((f) => !f.sinDatosSuficientes && f.comprar > 0).sort((a, b) => b.comprar - a.comprar)
  renderTable('auditoriaComprarLista',
    [{ label: 'Producto' }, { label: 'Tendencia (últ. mes)' }, { label: 'Comprar', num: true }, { label: 'Costo', num: true }],
    comprables,
    (f) => `<tr><td>${f.nombre}</td><td>${tendenciaBadge(f)}</td><td class="num"><b>${num(f.comprar)}</b></td><td class="num">${f.pcosto ? money(f.costoCompra) : 'sin costo'}</td></tr>`,
    'No hace falta comprar nada de esta marca por ahora — el stock actual alcanza para el periodo pedido. 🎉'
  )
}

function motivoRevision(f) {
  if (f.calzaConActual === false) return 'El inventario registrado no coincide con la existencia actual — no confiar en el cálculo, revisar a mano.'
  return `${num(f.cantidadVendida90d)} vendidas en 90 días, ${dec(f.diasEnCero, 1)} días sin stock — no hay suficiente información para proyectar.`
}

function renderAuditoriaRevision(filas) {
  const card = document.getElementById('auditoriaRevisionCard')
  const problematicos = filas.filter((f) => f.sinDatosSuficientes || f.calzaConActual === false)
  if (!problematicos.length) { card.style.display = 'none'; return }
  card.style.display = ''
  const lista = document.getElementById('auditoriaRevisionLista')
  lista.innerHTML = ''
  problematicos.forEach((f) => lista.appendChild(el(`<li><b>${f.nombre}</b> — ${motivoRevision(f)}</li>`)))
}

let auditoriaDetalleVisible = false
function toggleAuditoriaDetalle() {
  auditoriaDetalleVisible = !auditoriaDetalleVisible
  document.getElementById('auditoriaTabla').style.display = auditoriaDetalleVisible ? '' : 'none'
  document.getElementById('btnToggleAuditoriaDetalle').textContent = auditoriaDetalleVisible ? 'Ocultar detalle técnico' : 'Ver tabla de datos técnicos completos'
}

function pintarAuditoria(datos) {
  document.getElementById('auditoriaResultado').style.display = ''

  auditoriaDetalleVisible = false
  document.getElementById('auditoriaTabla').style.display = 'none'
  document.getElementById('btnToggleAuditoriaDetalle').textContent = 'Ver tabla de datos técnicos completos'

  renderAuditoriaKpis(datos)

  const { buckets, headline } = calcularTendenciaAgregada(datos.filas)
  const headlineEl = document.getElementById('auditoriaTendenciaHeadline')
  headlineEl.textContent = headline ? headline.texto : ''
  headlineEl.className = 'tendencia-headline' + (headline && headline.clase ? ' ' + headline.clase : '')
  const bucketsConLabel = buckets.map((b) => ({ ...b, label: mesBucketLabel(b.desde, b.hasta), rango: `${b.desde} a ${b.hasta}` }))
  renderAuditoriaTendenciaChart(document.getElementById('auditoriaChartTendencia'), bucketsConLabel, { num })

  renderAuditoriaComprarLista(datos.filas)
  renderAuditoriaRevision(datos.filas)
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
  // Mismo criterio que inventario-app: el usuario solo escribe el prefijo de
  // la marca, el '%' se agrega solo si no lo puso ya.
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
// Historial completo de un producto -- botón "📈 Histórico" en cada fila de
// Rotación de productos. Mismo patrón de solicitud+polling que Auditoría de
// compra, pero mucho más liviano (una sola consulta, no recorre el
// catálogo) -- pedido explícito del usuario (2026-08-09): "¿cuánto vendí
// históricamente de este producto?", sin tener que ir cambiando el rango de
// fechas a mano.
// ---------------------------------------------------------------------------
function abrirHistorial(codigo, nombre) {
  document.getElementById('historialOverlay').style.display = 'flex'
  document.getElementById('historialTitulo').textContent = 'Historial de "' + nombre + '"'
  document.getElementById('historialResultado').style.display = 'none'
  generarHistorial(codigo)
}
function cerrarHistorial() {
  document.getElementById('historialOverlay').style.display = 'none'
}

const MESES_LABEL = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic']

function pintarHistorial(datos) {
  document.getElementById('historialResultado').style.display = ''

  const box = document.getElementById('historialKpis')
  box.innerHTML = ''
  const cards = [
    { label: 'Unidades vendidas (histórico)', value: num(datos.cantidadTotal) },
    { label: 'Ingreso total (histórico)', value: money(datos.ingresoTotal) },
    { label: 'Primer registro', value: datos.primerMes ? `${MESES_LABEL[datos.primerMes.mes - 1]} ${datos.primerMes.anio}` : '—' },
    { label: 'Existencia actual', value: datos.existencia === null ? '—' : num(datos.existencia) },
  ]
  cards.forEach((c) => box.appendChild(el(`<div class="kpi-card"><div class="kpi-label">${c.label}</div><div class="kpi-value">${c.value}</div></div>`)))

  const buckets = datos.meses.map((m) => ({ label: `${MESES_LABEL[m.mes - 1]} ${String(m.anio).slice(2)}`, cantidad: m.cantidad, ingreso: m.ingreso }))
  renderAuditoriaTendenciaChart(document.getElementById('historialChart'), buckets, { num })

  renderTable('historialTabla',
    [{ label: 'Mes' }, { label: 'Unidades', num: true }, { label: 'Ingreso', num: true }],
    [...datos.meses].reverse(),
    (m) => `<tr><td>${MESES_LABEL[m.mes - 1]} ${m.anio}</td><td class="num">${num(m.cantidad)}</td><td class="num">${money(m.ingreso)}</td></tr>`,
    'Sin ventas registradas.'
  )
}

async function generarHistorial(codigo) {
  const statusEl = document.getElementById('historialStatus')
  statusEl.textContent = 'Solicitando a la tienda...'
  try {
    const { data, error } = await supabase
      .from('historial_producto_solicitudes')
      .insert({ codigo })
      .select('id')
      .single()
    if (error) { statusEl.textContent = 'Error: ' + error.message; return }

    const inicio = Date.now()
    const TIMEOUT_MS = 100000
    while (true) {
      await new Promise((r) => setTimeout(r, 1500))
      const { data: row, error: errRow } = await supabase
        .from('historial_producto_solicitudes')
        .select('status, mensaje, datos')
        .eq('id', data.id)
        .maybeSingle()
      if (errRow) { statusEl.textContent = 'Error: ' + errRow.message; return }
      if (row?.status === 'done') {
        statusEl.textContent = row.mensaje || 'Listo.'
        pintarHistorial(row.datos)
        return
      }
      if (row?.status === 'error') { statusEl.textContent = 'Error del agente: ' + (row.mensaje || 'sin detalle'); return }
      if (Date.now() - inicio > TIMEOUT_MS) {
        statusEl.textContent = 'La tienda no respondió a tiempo (¿está abierto el agente en la PC?).'
        return
      }
      statusEl.textContent = row?.status === 'running' ? 'Calculando en la tienda...' : 'Esperando que el agente tome la solicitud...'
    }
  } catch (err) {
    statusEl.textContent = 'Error: ' + err.message
  }
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------
function initApp() {
  renderQuickRanges()
  markActiveQuick()

  document.getElementById('btnRefresh').addEventListener('click', solicitarActualizacion)
  document.getElementById('btnExportarDashboard').addEventListener('click', exportarDashboard)
  document.getElementById('btnCerrarSesion').addEventListener('click', cerrarSesion)
  document.getElementById('btnAuditoria').addEventListener('click', abrirAuditoria)
  document.getElementById('btnCerrarAuditoria').addEventListener('click', cerrarAuditoria)
  document.getElementById('auditoriaOverlay').addEventListener('click', (e) => {
    if (e.target.id === 'auditoriaOverlay') cerrarAuditoria()
  })
  document.getElementById('auditoriaForm').addEventListener('submit', generarAuditoria)
  document.getElementById('btnExportarAuditoria').addEventListener('click', exportarAuditoria)
  document.getElementById('btnToggleAuditoriaDetalle').addEventListener('click', toggleAuditoriaDetalle)
  document.getElementById('btnCerrarHistorial').addEventListener('click', cerrarHistorial)
  document.getElementById('historialOverlay').addEventListener('click', (e) => {
    if (e.target.id === 'historialOverlay') cerrarHistorial()
  })
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
  document.getElementById('filtroProducto').addEventListener('input', () => { paginaRotacion = 1; renderRotacion() })
  document.getElementById('filtroDepto').addEventListener('change', () => { paginaRotacion = 1; renderRotacion() })
  document.getElementById('btnToggleInternas').addEventListener('click', () => {
    internasVisibles = !internasVisibles
    renderCuentasInternas(ultimoDatos && ultimoDatos.cuentasInternas)
  })
  document.getElementById('btnToggleDevoluciones').addEventListener('click', () => {
    devolucionesVisibles = !devolucionesVisibles
    renderDevoluciones(ultimoDatos && ultimoDatos.devoluciones)
  })
  document.getElementById('btnImprimir').addEventListener('click', () => window.print())
  document.getElementById('btnAlertas').addEventListener('click', abrirAlertas)
  document.getElementById('btnCerrarAlertas').addEventListener('click', cerrarAlertas)
  document.getElementById('alertasOverlay').addEventListener('click', (e) => {
    if (e.target.id === 'alertasOverlay') cerrarAlertas()
  })
  document.getElementById('btnCalcularAlertas').addEventListener('click', calcularAlertas)
  document.getElementById('filtroAlertas').addEventListener('input', renderAlertasTabla)

  // Rotación de productos pagina en pantalla (ver FILAS_POR_PAGINA), pero al
  // imprimir tiene que salir la tabla completa -- si no, solo se imprimiría
  // la página que estaba visible en ese momento.
  window.addEventListener('beforeprint', () => { imprimiendoRotacion = true; renderRotacion() })
  window.addEventListener('afterprint', () => { imprimiendoRotacion = false; renderRotacion() })

  cargarFechaMinima()
  cargarTendencia()
  cargarSalud()
  cargarUltimaAlerta()
  // Esperada antes de cargar() -- si no, pintar() puede correr antes de que
  // se sepa si ya existe una meta guardada, y muestra el formulario "cargar
  // meta" un instante de más aunque ya haya una.
  cargarMetaVenta().then(cargar)
}

iniciarGate()
