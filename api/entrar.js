// Función serverless de Vercel (se detecta sola por vivir en /api).
// Valida la clave del lado del servidor -- recién si es correcta entrega la
// URL/clave de Supabase al navegador. Antes de esto, ambas viajaban
// completas en el JavaScript público (variables VITE_), así que cualquiera
// podía extraerlas sin pasar nunca por acá. Ver SERVIDOR.md.
export default function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ ok: false, error: 'Método no permitido' });
    return;
  }

  const clave = (req.body && req.body.clave) || '';
  const claveReal = process.env.REPORTES_CLAVE || '';

  if (!claveReal) {
    res.status(500).json({ ok: false, error: 'No se configuró REPORTES_CLAVE en el servidor.' });
    return;
  }

  if (clave !== claveReal) {
    res.status(401).json({ ok: false, error: 'Clave incorrecta.' });
    return;
  }

  res.status(200).json({
    ok: true,
    supabaseUrl: process.env.SUPABASE_URL,
    supabaseAnonKey: process.env.SUPABASE_ANON_KEY,
  });
}
