// Función serverless de Vercel.
// Recibe el texto que "Habla conmigo" debe pronunciar en voz alta y llama a
// Gemini TTS a través de Vertex AI (gemini-2.5-flash-tts, GA, región
// us-central1), usando la cuenta de servicio configurada en
// GOOGLE_TTS_CREDENTIALS. El prompt busca una voz grave, casi susurrada, sin
// proyectar, íntima y serena con un brillo suave — con respiración y pausas
// tras cada idea importante (evitando instrucciones de ritmo general que
// causaban efecto "cámara lenta" en este canal).

const { GoogleAuth } = require('google-auth-library');

const PROYECTO = 'gen-lang-client-0888965075';
const REGION = 'us-central1';
const MODELO = 'gemini-2.5-flash-tts';

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
    const { text, idioma } = cuerpo || {};

    if (!text || typeof text !== 'string' || !text.trim()) {
      res.status(400).json({ error: 'Falta el texto a convertir en voz' });
      return;
    }

    if (!process.env.GOOGLE_TTS_CREDENTIALS) {
      res.status(500).json({ error: 'Falta configurar GOOGLE_TTS_CREDENTIALS en Vercel' });
      return;
    }

    const textoFinal = text.trim().slice(0, 8000);

    const prompt = idioma === 'en'
      ? `Say the following in English almost in a whisper, in a deep, hushed voice, close and unprojected, like a gentle lullaby glowing softly with serenity — breathe tenderly between phrases, pausing briefly after each important thought: "${textoFinal}"`
      : `Di lo siguiente en español casi en un susurro, con una voz grave y suave, cercana y sin proyectar, como un arrullo tierno que brilla suavemente con serenidad — respira con delicadeza entre frases, haciendo una breve pausa después de cada idea importante: "${textoFinal}"`;

    let credenciales;
    try {
      credenciales = JSON.parse(process.env.GOOGLE_TTS_CREDENTIALS);
    } catch (e) {
      res.status(500).json({ error: 'GOOGLE_TTS_CREDENTIALS no es un JSON válido' });
      return;
    }

    const auth = new GoogleAuth({
      credentials: credenciales,
      scopes: ['https://www.googleapis.com/auth/cloud-platform']
    });
    const cliente = await auth.getClient();
    const token = await cliente.getAccessToken();

    const url = `https://${REGION}-aiplatform.googleapis.com/v1/projects/${PROYECTO}/locations/${REGION}/publishers/google/models/${MODELO}:generateContent`;

    const respuestaVertex = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token.token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: {
          responseModalities: ['AUDIO'],
          temperature: 0.4,
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Zephyr' } }
          }
        }
      })
    });

    const datos = await respuestaVertex.json();

    if (!respuestaVertex.ok) {
      console.error('Error de Vertex AI:', JSON.stringify(datos));
      res.status(respuestaVertex.status).json({ error: (datos.error && datos.error.message) || 'Error al generar la voz con Vertex AI' });
      return;
    }

    const parte = datos.candidates && datos.candidates[0] && datos.candidates[0].content && datos.candidates[0].content.parts && datos.candidates[0].content.parts[0];
    const audioBase64 = parte && parte.inlineData && parte.inlineData.data;

    if (!audioBase64) {
      res.status(500).json({ error: 'Vertex AI no devolvió un audio válido' });
      return;
    }

    const pcmBuffer = Buffer.from(audioBase64, 'base64');
    const wavBuffer = agregarEncabezadoWav(pcmBuffer, 24000, 1, 16);

    res.setHeader('Content-Type', 'audio/wav');
    res.status(200).send(wavBuffer);
  } catch (error) {
    console.error('Error en la función tts.js:', error);
    res.status(500).json({ error: 'Error interno del servidor: ' + (error && error.message) });
  }
};

function agregarEncabezadoWav(datosPcm, sampleRate, numCanales, bitsPorMuestra) {
  const bloqueAlineado = (numCanales * bitsPorMuestra) / 8;
  const tasaBytes = sampleRate * bloqueAlineado;
  const encabezado = Buffer.alloc(44);
  encabezado.write('RIFF', 0);
  encabezado.writeUInt32LE(36 + datosPcm.length, 4);
  encabezado.write('WAVE', 8);
  encabezado.write('fmt ', 12);
  encabezado.writeUInt32LE(16, 16);
  encabezado.writeUInt16LE(1, 20);
  encabezado.writeUInt16LE(numCanales, 22);
  encabezado.writeUInt32LE(sampleRate, 24);
  encabezado.writeUInt32LE(tasaBytes, 28);
  encabezado.writeUInt16LE(bloqueAlineado, 32);
  encabezado.writeUInt16LE(bitsPorMuestra, 34);
  encabezado.write('data', 36);
  encabezado.writeUInt32LE(datosPcm.length, 40);
  return Buffer.concat([encabezado, datosPcm]);
}
