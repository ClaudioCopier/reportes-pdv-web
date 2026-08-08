// Función serverless de Vercel (se detecta sola por vivir en /api).
// Valida la clave del lado del servidor -- recién si es correcta entrega la
// URL/clave de Supabase al navegador. Antes de esto, ambas viajaban
// completas en el JavaScript público (variables VITE_), así que cualquiera
// podía extraerlas sin pasar nunca por acá. Ver SERVIDOR.md.

// Rate-limiting por IP (2026-08-08) -- antes no había ningún límite de
// intentos, alguien podía probar claves sin parar. Mapa en memoria del
// proceso: se resetea si la función serverless se "enfría" (Vercel no
// garantiza que la misma instancia siga viva entre requests), así que esto
// NO es un límite duro a nivel de infraestructura -- pero para el tráfico
// real de este sitio (bajo, casi siempre la misma instancia se reusa un
// rato) igual sube mucho el costo de probar claves a repetición, que hoy es
// cero. Si en el futuro hace falta un límite garantizado, la alternativa es
// una tabla en Supabase (persistente entre instancias) -- se optó por esto
// primero por ser mucho más simple y no depender de una tabla/migración
// nueva para un gate de una sola clave compartida.
const MAX_INTENTOS = 5;
const VENTANA_MS = 15 * 60 * 1000;
const BLOQUEO_MS = 15 * 60 * 1000;
const intentosPorIp = new Map();

function limpiarViejos() {
  const ahora = Date.now();
  for (const [ip, estado] of intentosPorIp) {
    if (estado.bloqueadoHasta && estado.bloqueadoHasta < ahora) { intentosPorIp.delete(ip); continue; }
    if (!estado.bloqueadoHasta && ahora - estado.primerIntento > VENTANA_MS) intentosPorIp.delete(ip);
  }
}

function obtenerIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (fwd) return String(fwd).split(',')[0].trim();
  return req.socket?.remoteAddress || 'desconocida';
}

export default function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ ok: false, error: 'Método no permitido' });
    return;
  }

  limpiarViejos();
  const ip = obtenerIp(req);
  const ahora = Date.now();
  const estado = intentosPorIp.get(ip);

  if (estado?.bloqueadoHasta && estado.bloqueadoHasta > ahora) {
    const minutosRestantes = Math.ceil((estado.bloqueadoHasta - ahora) / 60000);
    res.status(429).json({ ok: false, error: `Demasiados intentos fallidos. Probá de nuevo en ${minutosRestantes} min.` });
    return;
  }

  const clave = (req.body && req.body.clave) || '';
  const claveReal = process.env.REPORTES_CLAVE || '';

  if (!claveReal) {
    res.status(500).json({ ok: false, error: 'No se configuró REPORTES_CLAVE en el servidor.' });
    return;
  }

  if (clave !== claveReal) {
    const yaExiste = estado && ahora - estado.primerIntento <= VENTANA_MS;
    const intentos = (yaExiste ? estado.intentos : 0) + 1;
    if (intentos >= MAX_INTENTOS) {
      intentosPorIp.set(ip, { intentos, primerIntento: yaExiste ? estado.primerIntento : ahora, bloqueadoHasta: ahora + BLOQUEO_MS });
      res.status(429).json({ ok: false, error: `Demasiados intentos fallidos. Probá de nuevo en ${Math.ceil(BLOQUEO_MS / 60000)} min.` });
      return;
    }
    intentosPorIp.set(ip, { intentos, primerIntento: yaExiste ? estado.primerIntento : ahora, bloqueadoHasta: null });
    res.status(401).json({ ok: false, error: 'Clave incorrecta.' });
    return;
  }

  intentosPorIp.delete(ip);
  res.status(200).json({
    ok: true,
    supabaseUrl: process.env.SUPABASE_URL,
    supabaseAnonKey: process.env.SUPABASE_ANON_KEY,
  });
}
