// Función serverless de Vercel.
// Recibe los mensajes del chat "Habla conmigo" y llama a Gemini a través de
// Vertex AI (gemini-2.5-flash, GA, región us-central1), usando la misma
// cuenta de servicio empresarial que ya usa tts.js (GOOGLE_TTS_CREDENTIALS).
//
// Usa el endpoint de STREAMING de Vertex AI (streamGenerateContent, con
// ?alt=sse) en vez de esperar la respuesta completa, para que el texto de
// SANA aparezca progresivamente en vez de que la persona espere varios
// segundos en blanco.

const { GoogleAuth } = require('google-auth-library');

const PROYECTO = 'gen-lang-client-0888965075';
const REGION = 'us-central1';
const MODELO = 'gemini-2.5-flash';

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
