// Export a Excel del dashboard completo YA CARGADO en memoria (no vuelve a
// pedir nada a Supabase) -- una hoja por sección, mismo patrón de carga
// diferida de exceljs que exportarAuditoriaExcel.js. Pedido explícito del
// usuario (2026-08-08): poder sacar un respaldo/resumen del periodo
// seleccionado sin tener que copiar tablas a mano.
const COLOR_HEADER = 'FF154832'

function estilarHeader(hoja) {
  hoja.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLOR_HEADER } }
  hoja.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } }
}

function hojaResumen(wb, datos) {
  const hoja = wb.addWorksheet('Resumen')
  hoja.columns = [
    { header: 'Métrica', key: 'metrica', width: 26 },
    { header: 'Periodo actual', key: 'actual', width: 18 },
    { header: 'Periodo anterior', key: 'anterior', width: 18 },
  ]
  estilarHeader(hoja)

  hoja.addRow({ metrica: 'Periodo', actual: `${datos.periodo.desde} a ${datos.periodo.hasta}`, anterior: datos.periodoAnterior ? `${datos.periodoAnterior.desde} a ${datos.periodoAnterior.hasta}` : '' })
  hoja.addRow({})

  const r = datos.resumen
  const p = datos.resumenAnterior || {}
  const filas = [
    ['Tickets', r.tickets, p.tickets],
    ['Artículos vendidos', r.articulos, p.articulos],
    ['Ventas (ingreso bruto)', r.total, p.total],
    ['Costo de mercadería', r.costo, p.costo],
    ['Ganancia bruta', r.gananciaBruta, p.gananciaBruta],
    ['Margen bruto %', r.margenPct, p.margenPct],
    ['Ticket promedio', r.ticketPromedio, p.ticketPromedio],
  ]
  for (const [metrica, actual, anterior] of filas) {
    hoja.addRow({ metrica, actual, anterior: anterior === undefined ? '' : anterior })
  }
}

function hojaVentasDiarias(wb, ventasDiarias) {
  const hoja = wb.addWorksheet('Ventas diarias')
  hoja.columns = [
    { header: 'Día', key: 'dia', width: 14 },
    { header: 'Tickets', key: 'tickets', width: 10 },
    { header: 'Total', key: 'total', width: 14 },
    { header: 'Costo', key: 'costo', width: 14 },
    { header: 'Ganancia bruta', key: 'gananciaBruta', width: 16 },
  ]
  estilarHeader(hoja)
  for (const d of ventasDiarias) hoja.addRow(d)
}

function hojaRotacion(wb, productos) {
  const hoja = wb.addWorksheet('Rotación de productos')
  hoja.columns = [
    { header: 'Código', key: 'codigo', width: 16 },
    { header: 'Producto', key: 'nombre', width: 40 },
    { header: 'Departamento', key: 'departamento', width: 20 },
    { header: 'Cantidad', key: 'cantidad', width: 10 },
    { header: 'Ingreso', key: 'ingreso', width: 14 },
    { header: 'Costo', key: 'costo', width: 14 },
    { header: 'Ganancia bruta', key: 'gananciaBruta', width: 16 },
    { header: 'Margen %', key: 'margenPct', width: 10 },
    { header: '% del ingreso total', key: 'pctDeIngresoTotal', width: 16 },
    { header: 'Unid./día', key: 'velocidadDia', width: 10 },
    { header: 'Existencia', key: 'existencia', width: 10 },
    { header: 'Días de inventario', key: 'diasDeInventario', width: 16 },
    { header: 'Clase ABC', key: 'clasificacionABC', width: 10 },
    { header: 'Incluye venta de hoy sin confirmar', key: 'estimado', width: 18 },
  ]
  estilarHeader(hoja)
  for (const p of productos) hoja.addRow({ ...p, estimado: p.estimado ? 'Sí' : '' })
}

function hojaPorDepartamento(wb, deptos) {
  const hoja = wb.addWorksheet('Por departamento')
  hoja.columns = [
    { header: 'Departamento', key: 'departamento', width: 22 },
    { header: 'Productos distintos', key: 'productosDistintos', width: 16 },
    { header: 'Cantidad', key: 'cantidad', width: 10 },
    { header: 'Ingreso', key: 'ingreso', width: 14 },
    { header: 'Costo', key: 'costo', width: 14 },
    { header: 'Ganancia bruta', key: 'gananciaBruta', width: 16 },
    { header: 'Margen %', key: 'margenPct', width: 10 },
  ]
  estilarHeader(hoja)
  for (const d of deptos) hoja.addRow(d)
}

function hojaFormasPago(wb, formas) {
  const hoja = wb.addWorksheet('Formas de pago')
  hoja.columns = [
    { header: 'Forma de pago', key: 'forma', width: 18 },
    { header: 'Tickets', key: 'tickets', width: 10 },
    { header: 'Total', key: 'total', width: 14 },
  ]
  estilarHeader(hoja)
  for (const f of formas) hoja.addRow(f)
}

function hojaPorCajero(wb, cajeros) {
  const hoja = wb.addWorksheet('Por cajero')
  hoja.columns = [
    { header: 'Cajero', key: 'cajero', width: 22 },
    { header: 'Tickets', key: 'tickets', width: 10 },
    { header: 'Total', key: 'total', width: 14 },
    { header: 'Ganancia bruta', key: 'gananciaBruta', width: 16 },
  ]
  estilarHeader(hoja)
  for (const c of cajeros || []) hoja.addRow(c)
}

function hojaStockBajo(wb, stock, esRango) {
  const hoja = wb.addWorksheet('Stock bajo')
  hoja.columns = [
    { header: 'Código', key: 'codigo', width: 16 },
    { header: 'Producto', key: 'descripcion', width: 40 },
    { header: 'Departamento', key: 'departamento', width: 20 },
    { header: 'Existencia', key: 'existencia', width: 10 },
    { header: 'Mínimo', key: 'minimo', width: 10 },
  ]
  estilarHeader(hoja)
  if (esRango) {
    hoja.addRow({ codigo: 'No disponible para rangos personalizados (es una foto del momento, no se puede sumar entre días).' })
    return
  }
  for (const s of stock) hoja.addRow(s)
}

function hojaFlujoCaja(wb, caja) {
  const hoja = wb.addWorksheet('Flujo de caja')
  hoja.columns = [
    { header: 'Concepto', key: 'concepto', width: 30 },
    { header: 'N° movimientos', key: 'veces', width: 16 },
    { header: 'Total', key: 'total', width: 14 },
  ]
  estilarHeader(hoja)
  hoja.addRow({ concepto: 'Entradas de caja', veces: caja.entradasCaja.veces, total: caja.entradasCaja.total })
  hoja.addRow({ concepto: 'Salidas de caja', veces: caja.salidasCaja.veces, total: caja.salidasCaja.total })
  hoja.addRow({ concepto: 'Pagos de abonos recibidos', veces: caja.pagosAbonos.veces, total: caja.pagosAbonos.total })
  hoja.addRow({})
  hoja.addRow({ concepto: 'Salidas por categoría' }).font = { bold: true }
  for (const c of caja.salidasPorCategoria) hoja.addRow({ concepto: c.categoria, veces: c.veces, total: c.total })
}

function hojaCuentasInternas(wb, internas) {
  const hoja = wb.addWorksheet('Cuentas internas')
  hoja.columns = [
    { header: 'Fecha', key: 'fecha', width: 20 },
    { header: 'Cuenta', key: 'cuenta', width: 20 },
    { header: 'Cajero', key: 'cajero', width: 20 },
    { header: 'Artículos', key: 'articulos', width: 50 },
    { header: 'Total', key: 'total', width: 14 },
  ]
  estilarHeader(hoja)
  for (const m of internas.movimientos || []) {
    const arts = (m.articulos || []).map((a) => `${a.nombre || a.codigo} x${a.cantidad}`).join(', ')
    hoja.addRow({ fecha: new Date(m.vendidoEn).toLocaleString('es-CL'), cuenta: m.cuenta, cajero: m.cajero, articulos: arts, total: m.total })
  }
}

function hojaDevoluciones(wb, devoluciones) {
  const hoja = wb.addWorksheet('Devoluciones')
  hoja.columns = [
    { header: 'Tipo', key: 'tipo', width: 20 },
    { header: 'Fecha', key: 'fecha', width: 20 },
    { header: 'Cajero', key: 'cajero', width: 20 },
    { header: 'Detalle', key: 'detalle', width: 40 },
    { header: 'Monto', key: 'monto', width: 14 },
  ]
  estilarHeader(hoja)
  const d = devoluciones || { ticketsAnulados: [], lineasDevueltas: [] }
  for (const t of d.ticketsAnulados) {
    hoja.addRow({ tipo: 'Ticket anulado', fecha: new Date(t.vendidoEn).toLocaleString('es-CL'), cajero: t.cajero, detalle: `Folio ${t.folio}`, monto: t.total })
  }
  for (const l of d.lineasDevueltas) {
    hoja.addRow({
      tipo: l.devolucionTotal ? 'Devolución total' : 'Devolución parcial',
      fecha: new Date(l.vendidoEn).toLocaleString('es-CL'), cajero: l.cajero,
      detalle: `${l.nombre} x${l.cantidadDevuelta}`, monto: l.montoDevuelto,
    })
  }
}

function hojaMargenNegativo(wb, productos) {
  const hoja = wb.addWorksheet('Margen negativo')
  hoja.columns = [
    { header: 'Código', key: 'codigo', width: 16 },
    { header: 'Producto', key: 'nombre', width: 40 },
    { header: 'Cantidad', key: 'cantidad', width: 10 },
    { header: 'Ingreso', key: 'ingreso', width: 14 },
    { header: 'Costo', key: 'costo', width: 14 },
    { header: 'Pérdida', key: 'perdida', width: 14 },
    { header: 'Margen %', key: 'margenPct', width: 10 },
  ]
  estilarHeader(hoja)
  for (const p of (productos || []).filter((p) => p.margenPct < 0)) {
    hoja.addRow({ codigo: p.codigo, nombre: p.nombre, cantidad: p.cantidad, ingreso: p.ingreso, costo: p.costo, perdida: Math.abs(p.gananciaBruta), margenPct: p.margenPct })
  }
}

function hojaStockMuerto(wb, stockMuerto, esRango) {
  const hoja = wb.addWorksheet('Stock muerto (90d)')
  hoja.columns = [
    { header: 'Código', key: 'codigo', width: 16 },
    { header: 'Producto', key: 'descripcion', width: 40 },
    { header: 'Departamento', key: 'departamento', width: 20 },
    { header: 'Existencia', key: 'existencia', width: 10 },
    { header: 'Capital inmovilizado', key: 'capitalInmovilizado', width: 18 },
  ]
  estilarHeader(hoja)
  if (esRango) {
    hoja.addRow({ codigo: 'No disponible para rangos personalizados (es una foto del momento).' })
    return
  }
  for (const p of stockMuerto || []) hoja.addRow(p)
}

function hojaInteranual(wb, cmp) {
  if (!cmp) return
  const hoja = wb.addWorksheet('Vs. año pasado')
  hoja.columns = [
    { header: 'Métrica', key: 'metrica', width: 22 },
    { header: 'Este periodo', key: 'actual', width: 18 },
    { header: `${cmp.periodoAnteriorDesde} a ${cmp.periodoAnteriorHasta}`, key: 'previo', width: 24 },
  ]
  estilarHeader(hoja)
  if (cmp.sinDatosPrevios) {
    hoja.addRow({ metrica: 'Sin ventas registradas en el periodo del año pasado.' })
    return
  }
  hoja.addRow({ metrica: 'Ventas', actual: cmp.actual.total, previo: cmp.previo.total })
  hoja.addRow({ metrica: 'Ganancia bruta', actual: cmp.actual.gananciaBruta, previo: cmp.previo.gananciaBruta })
  hoja.addRow({ metrica: 'Tickets', actual: cmp.actual.tickets, previo: cmp.previo.tickets })
}

export async function exportarDashboardExcel(datos, { modoRango = false } = {}) {
  const ExcelJS = (await import('exceljs')).default
  const wb = new ExcelJS.Workbook()

  hojaResumen(wb, datos)
  hojaVentasDiarias(wb, datos.ventasDiarias)
  hojaRotacion(wb, datos.rotacionProductos)
  hojaPorDepartamento(wb, datos.rotacionPorDepartamento)
  hojaFormasPago(wb, datos.formasPago)
  hojaPorCajero(wb, datos.ventasPorCajero)
  hojaStockBajo(wb, datos.stockBajo, modoRango)
  hojaMargenNegativo(wb, datos.rotacionProductos)
  hojaStockMuerto(wb, datos.stockMuerto, modoRango)
  hojaFlujoCaja(wb, datos.flujoCaja)
  hojaCuentasInternas(wb, datos.cuentasInternas)
  hojaDevoluciones(wb, datos.devoluciones)
  hojaInteranual(wb, datos.comparativoInteranual)

  const buffer = await wb.xlsx.writeBuffer()
  const blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `reporte_ventas_${datos.periodo.desde}_a_${datos.periodo.hasta}.xlsx`
  a.click()
  URL.revokeObjectURL(url)
}
