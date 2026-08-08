// Función serverless de Vercel, disparada por un cron externo (GitHub
// Actions, ver .github/workflows/verificar-agente.yml en este repo -- el
// cron nativo de Vercel en el plan gratuito solo permite una corrida por
// día, no alcanza para chequear cada 15 min). Pedido explícito del usuario
// (2026-08-08): avisarle por WhatsApp si el agente de la tienda no está
// prendido a las 10:30, o si se cae en algún momento entre las 10:30 y las
// 21:00 -- hasta ahora la única señal era el banner de reportes-web, que
// nadie ve si no abre el sitio.
//
// "Caerse" acá significa que dejó de mandar heartbeat por un rato largo
// (mismo umbral de 45 min que ya usa el banner de reportes-web) -- NO un
// corte de wifi de un par de minutos, de esos hay varios por día y se
// recuperan solos (agente.js reintenta cada 5 min mientras está
// desconectado, así que un corte real de 45+ min ya es sí o sí más grave
// que un hipo de red, sea porque se cerró la ventana o porque el internet
// de la tienda estuvo mal en serio).
import { createClient } from '@supabase/supabase-js';

const UMBRAL_CAIDO_MS = 45 * 60 * 1000;
const VENTANA_DESDE_HORA = 10.5; // 10:30
const VENTANA_HASTA_HORA = 21; // 21:00

function horaLocalSantiago() {
  const partes = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Santiago', hour: 'numeric', minute: 'numeric', hourCycle: 'h23',
  }).formatToParts(new Date());
  const hora = Number(partes.find((p) => p.type === 'hour').value);
  const minuto = Number(partes.find((p) => p.type === 'minute').value);
  return hora + minuto / 60;
}

async function enviarWhatsapp(mensaje) {
  const phone = process.env.CALLMEBOT_PHONE;
  const apikey = process.env.CALLMEBOT_APIKEY;
  if (!phone || !apikey) throw new Error('Faltan CALLMEBOT_PHONE/CALLMEBOT_APIKEY en el servidor.');
  const url = `https://api.callmebot.com/whatsapp.php?phone=${encodeURIComponent(phone)}&text=${encodeURIComponent(mensaje)}&apikey=${encodeURIComponent(apikey)}`;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`CallMeBot respondió ${resp.status}: ${await resp.text()}`);
}

export default async function handler(req, res) {
  // Protege el endpoint de que cualquiera en internet lo llame a repetición
  // (no podría forzar un aviso falso -- el estado sale de Supabase, no del
  // request -- pero sí podría gastar la cuota de CallMeBot en un apagón
  // real). Mismo secreto que configura el workflow de GitHub Actions.
  // "fail closed": si CRON_SECRET no está configurado todavía en Vercel,
  // req.query.secret (undefined, sin ?secret= en la URL) y
  // process.env.CRON_SECRET (undefined) quedarían "iguales" -- bug real
  // encontrado probando en producción el mismo día: sin esta primera
  // condición, cualquiera podía llamar al endpoint sin ningún secreto
  // mientras la variable no estuviera cargada.
  if (!process.env.CRON_SECRET || req.query.secret !== process.env.CRON_SECRET) {
    res.status(401).json({ ok: false, error: 'No autorizado' });
    return;
  }

  const hora = horaLocalSantiago();
  if (hora < VENTANA_DESDE_HORA || hora >= VENTANA_HASTA_HORA) {
    res.status(200).json({ ok: true, accion: 'fuera de horario, no se revisa', hora });
    return;
  }

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
  const { data, error } = await supabase.from('agente_estado').select('ultimo_latido, alerta_enviada_en').eq('id', 1).maybeSingle();
  if (error) {
    res.status(500).json({ ok: false, error: error.message });
    return;
  }
  if (!data) {
    res.status(200).json({ ok: true, accion: 'sin fila agente_estado todavía, nada que revisar' });
    return;
  }

  const minutosCaido = data.ultimo_latido ? Math.round((Date.now() - new Date(data.ultimo_latido).getTime()) / 60000) : null;
  const estaCaido = minutosCaido === null || minutosCaido * 60000 > UMBRAL_CAIDO_MS;

  if (!estaCaido) {
    res.status(200).json({ ok: true, accion: 'agente activo', minutosCaido });
    return;
  }

  if (data.alerta_enviada_en) {
    res.status(200).json({ ok: true, accion: 'ya se había avisado esta caída, no se repite', minutosCaido });
    return;
  }

  const mensaje = minutosCaido === null
    ? 'Punto Verde Organic: el agente de la tienda nunca mandó ningún aviso -- revisar si está prendido.'
    : `Punto Verde Organic: el agente de la tienda no responde hace ${minutosCaido} min. Revisar la PC de la tienda.`;

  try {
    await enviarWhatsapp(mensaje);
  } catch (e) {
    res.status(500).json({ ok: false, error: 'No se pudo enviar el WhatsApp: ' + e.message });
    return;
  }

  const { error: errUpdate } = await supabase.from('agente_estado').update({ alerta_enviada_en: new Date().toISOString() }).eq('id', 1);
  if (errUpdate) {
    res.status(500).json({ ok: false, error: 'Aviso enviado pero no se pudo marcar en Supabase: ' + errUpdate.message });
    return;
  }

  res.status(200).json({ ok: true, accion: 'aviso enviado', minutosCaido });
}
