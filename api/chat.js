// Función serverless de Vercel.
// Recibe los mensajes del chat "Habla conmigo" y llama a Gemini a través de
// Vertex AI (gemini-2.5-flash, GA, región us-central1), usando la misma
// cuenta de servicio empresarial que ya usa tts.js (GOOGLE_TTS_CREDENTIALS).
//
// IMPORTANTE: esta función usa el endpoint de STREAMING de Vertex AI
// (streamGenerateContent, con ?alt=sse) en vez de esperar la respuesta
// completa. Esto permite que Index.html muestre el texto de SANA
// apareciendo progresivamente, en vez de que la persona espere varios
// segundos en blanco antes de ver algo. El texto que Google genera tarda
// lo mismo por dentro — lo que cambia es que ya no se espera todo junto.

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

    // ?alt=sse le pide a Vertex AI que entregue la respuesta como
    // "Server-Sent Events" — un flujo de fragmentos de texto a medida que
    // el modelo los genera, en vez de un solo bloque al final.
    const url = `https://${REGION}-aiplatform.googleapis.com/v1/projects/${PROYECTO}/locations/${REGION}/publishers/google/models/${MODELO}:streamGenerateContent?alt=sse`;

    const respuestaVertex = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(cuerpoSolicitud)
    });

    if (!respuestaVertex.ok) {
      // Si Vertex AI rechaza la solicitud, la respuesta no viene en
      // formato de streaming — es un JSON de error normal.
      let datosError = {};
      try { datosError = await respuestaVertex.json(); } catch (e) {}
      console.error('Error de Vertex AI (chat):', JSON.stringify(datosError));
      if (respuestaVertex.status === 401 || respuestaVertex.status === 403) {
        tokenCacheado = null;
        tokenVenceEn = 0;
      }
      res.status(respuestaVertex.status).json({ error: (datosError.error && datosError.error.message) || 'Error al hablar con Vertex AI' });
      return;
    }

    // A partir de aquí, reenviamos el flujo de Vertex AI hacia Index.html
    // tal como va llegando, fragmento por fragmento.
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    if (res.flushHeaders) res.flushHeaders();

    const lector = respuestaVertex.body.getReader();
    try {
      while (true) {
        const { done, value } = await lector.read();
        if (done) break;
        res.write(value);
        if (res.flush) res.flush();
      }
    } finally {
      res.end();
    }
  } catch (error) {
    console.error('Error en la función chat.js:', error);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Error interno del servidor: ' + (error && error.message) });
    } else {
      res.end();
    }
  }
};
