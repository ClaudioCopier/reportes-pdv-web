// Auditoría de compra -- export a Excel de un resultado YA CARGADO en
// memoria (la solicitud a agente-servidor ya trajo todo en `datos`, esto no
// vuelve a pedir nada a Supabase). Mismo patrón de carga diferida de
// exceljs que APP INVENTARIOS/inventario-app/src/lib/exportarInventarioExcel.js.
export async function exportarAuditoriaExcel(datos) {
  const ExcelJS = (await import('exceljs')).default

  const wb = new ExcelJS.Workbook()
  const hoja = wb.addWorksheet('Auditoría de compra')
  const nombresBuckets = (datos.filas[0]?.mensual || []).map((m) => `${m.desde} a ${m.hasta}`)

  hoja.columns = [
    { header: 'Codigo', key: 'codigo', width: 16 },
    { header: 'Producto', key: 'nombre', width: 42 },
    { header: 'Existencia', key: 'existenciaActual', width: 12 },
    { header: 'Costo unit.', key: 'pcosto', width: 12 },
    { header: 'Vendido 90d', key: 'cantidadVendida90d', width: 12 },
    { header: 'Dias en $0 stock', key: 'diasEnCero', width: 14 },
    { header: 'Venta ajustada/mes', key: 'ventaAjustadaMes', width: 16 },
    { header: 'Objetivo', key: 'objetivo', width: 10 },
    { header: 'Comprar', key: 'comprar', width: 10 },
    { header: 'Costo compra', key: 'costoCompra', width: 14 },
    { header: 'Sin datos suficientes', key: 'sinDatosSuficientes', width: 16 },
    ...nombresBuckets.flatMap((label, i) => ([
      { header: `${label} — cantidad`, key: `m${i}_cantidad`, width: 20 },
      { header: `${label} — vta ajustada`, key: `m${i}_ajustada`, width: 20 },
      { header: `${label} — crecim. %`, key: `m${i}_crec`, width: 16 },
    ])),
  ]
  hoja.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF154832' } }
  hoja.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } }

  for (const f of datos.filas) {
    const fila = {
      codigo: f.codigo,
      nombre: f.nombre,
      existenciaActual: f.existenciaActual,
      pcosto: f.pcosto,
      cantidadVendida90d: f.cantidadVendida90d,
      diasEnCero: f.diasEnCero,
      ventaAjustadaMes: f.ventaAjustadaMes,
      objetivo: f.objetivo,
      comprar: f.comprar,
      costoCompra: f.costoCompra,
      sinDatosSuficientes: f.sinDatosSuficientes ? 'Si' : '',
    }
    ;(f.mensual || []).forEach((m, i) => {
      fila[`m${i}_cantidad`] = m.cantidadVendida
      fila[`m${i}_ajustada`] = m.ventaAjustada
      fila[`m${i}_crec`] = m.crecimientoPct
    })
    hoja.addRow(fila)
  }

  const buffer = await wb.xlsx.writeBuffer()
  const blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  const fecha = new Date().toISOString().slice(0, 10)
  const patronLimpio = (datos.patron || 'auditoria').replace(/[^a-z0-9]+/gi, '_')
  a.href = url
  a.download = `auditoria_compra_${patronLimpio}_${fecha}.xlsx`
  a.click()
  URL.revokeObjectURL(url)

  return datos.filas.length
}
