// Función serverless de Vercel.
// Recibe los mensajes del chat "Habla conmigo" y llama a Gemini a través de
// Vertex AI (gemini-2.5-flash, GA, región us-central1), usando la misma
// cuenta de servicio empresarial que ya usa tts.js (GOOGLE_TTS_CREDENTIALS).
// Esto reemplaza el uso anterior de la API pública de AI Studio, cuya cuota
// gratuita se agotaba con facilidad durante las pruebas.
//
// NOTA: se intentó una versión con streaming (respuesta progresiva) pero
// se revirtió temporalmente por un problema en producción — el texto no
// llegaba. Queda pendiente investigar con los logs de Vercel antes de
// volver a intentarlo.

const { GoogleAuth } = require('google-auth-library');

const PROYECTO = 'gen-lang-client-0888965075';
const REGION = 'us-central1';
const MODELO = 'gemini-2.5-flash';

// Caché del token de acceso a Google Cloud entre invocaciones de la misma
// instancia de la función (igual que en tts.js) — evita pedir un token
// nuevo en cada mensaje cuando no es necesario.
let tokenCacheado = null;
let tokenVenceEn = 0;

async function obtenerTokenDeAcceso(credenciales) {
  const ahora = Date.now();
  if (tokenCacheado && ahora < tokenVenceEn) {
    return tokenCacheado;
  }
  const auth = new GoogleAuth({
    credentials: credenciales,
    scopes: ['https://www.googleapis.com/auth/cloud-platform']
  });
  const cliente = await auth.getClient();
  const token = await cliente.getAccessToken();
  tokenCacheado = token.token;
  tokenVenceEn = ahora + (55 * 60 * 1000);
  return tokenCacheado;
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  try {
    if (req.method === 'OPTIONS') {
      res.status(200).end();
      return;
    }

    if (req.method !== 'POST') {
      res.status(405).json({ error: 'Método no permitido' });
      return;
    }

    let cuerpo = req.body;
    if (typeof cuerpo === 'string') {
      try { cuerpo = JSON.parse(cuerpo); } catch (e) { cuerpo = {}; }
    }
    const { messages, system } = cuerpo || {};

    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      res.status(400).json({ error: 'Faltan mensajes' });
      return;
    }

    if (!process.env.GOOGLE_TTS_CREDENTIALS) {
      res.status(500).json({ error: 'Falta configurar GOOGLE_TTS_CREDENTIALS en Vercel' });
      return;
    }

    const contenidoGemini = messages.map((m) => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }]
    }));

    const cuerpoSolicitud = {
      contents: contenidoGemini,
      generationConfig: {
        maxOutputTokens: 2048
      }
    };
    if (system) {
      cuerpoSolicitud.systemInstruction = { parts: [{ text: system }] };
    }

    let credenciales;
    try {
      credenciales = JSON.parse(process.env.GOOGLE_TTS_CREDENTIALS);
    } catch (e) {
      res.status(500).json({ error: 'GOOGLE_TTS_CREDENTIALS no es un JSON válido' });
      return;
    }

    const accessToken = await obtenerTokenDeAcceso(credenciales);

    const url = `https://${REGION}-aiplatform.googleapis.com/v1/projects/${PROYECTO}/locations/${REGION}/publishers/google/models/${MODELO}:generateContent`;

    const respuestaVertex = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(cuerpoSolicitud)
    });

    const datos = await respuestaVertex.json();

    if (!respuestaVertex.ok) {
      console.error('Error de Vertex AI (chat):', JSON.stringify(datos));
      if (respuestaVertex.status === 401 || respuestaVertex.status === 403) {
        tokenCacheado = null;
        tokenVenceEn = 0;
      }
      res.status(respuestaVertex.status).json({ error: (datos.error && datos.error.message) || 'Error al hablar con Vertex AI' });
      return;
    }

    const texto =
      datos.candidates &&
      datos.candidates[0] &&
      datos.candidates[0].content &&
      datos.candidates[0].content.parts &&
      datos.candidates[0].content.parts[0] &&
      datos.candidates[0].content.parts[0].text;

    if (!texto) {
      console.error('Respuesta de Vertex AI sin texto:', JSON.stringify(datos));
      res.status(500).json({ error: 'Vertex AI no devolvió una respuesta válida' });
      return;
    }

    res.status(200).json({ content: [{ text: texto }] });
  } catch (error) {
    console.error('Error en la función chat.js:', error);
    res.status(500).json({ error: 'Error interno del servidor: ' + (error && error.message) });
  }
};
