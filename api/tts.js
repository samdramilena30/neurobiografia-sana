// Función serverless de Vercel.
// Recibe el texto que "Habla conmigo" debe pronunciar en voz alta y llama al
// modelo de texto a voz de Gemini, usando la MISMA clave (GEMINI_API_KEY) que
// ya está configurada en Vercel para el chat. No requiere ninguna cuenta ni
// clave nueva. Devuelve un audio WAV que el navegador reproduce directamente
// — así la voz es siempre la misma, cálida y natural, sin depender del
// sintetizador de voz de cada celular.

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
    const { text, idioma, forzarPago } = cuerpo || {};

    if (!text || typeof text !== 'string' || !text.trim()) {
      res.status(400).json({ error: 'Falta el texto a convertir en voz' });
      return;
    }

    if (!process.env.GEMINI_API_KEY) {
      res.status(500).json({ error: 'Falta configurar GEMINI_API_KEY en Vercel' });
      return;
    }

    const voz = process.env.GEMINI_TTS_VOICE || 'Zephyr';

    const textoFinal = text.trim().slice(0, 8000);

    const prompt = idioma === 'en'
      ? `Say the following in English, with a warm, calm, unhurried voice: "${textoFinal}"`
      : `Di lo siguiente en español, con voz cálida, serena y pausada: "${textoFinal}"`;

    const modelos = [
      process.env.GEMINI_TTS_MODEL || 'gemini-2.5-flash-preview-tts'
    ];

    const claves = [];
    if (forzarPago && process.env.GEMINI_API_KEY_PAGO) {
      claves.push({ key: process.env.GEMINI_API_KEY_PAGO, etiqueta: 'pago (forzada)' });
    } else {
      claves.push({ key: process.env.GEMINI_API_KEY, etiqueta: 'gratis' });
      if (process.env.GEMINI_API_KEY_PAGO) {
        claves.push({ key: process.env.GEMINI_API_KEY_PAGO, etiqueta: 'pago (respaldo)' });
      }
    }

    let audioBase64 = null;
    let ultimoError = null;
    let ultimoStatus = 500;

    const TIEMPO_LIMITE_POR_INTENTO_MS = 50000;
    const MAX_INTENTOS_POR_LLAMADA = 2;
    let intentosRealizados = 0;

    async function llamarGeminiConLimite(url, opciones) {
      const controlador = new AbortController();
      const temporizador = setTimeout(() => controlador.abort(), TIEMPO_LIMITE_POR_INTENTO_MS);
      try {
        return await fetch(url, { ...opciones, signal: controlador.signal });
      } finally {
        clearTimeout(temporizador);
      }
    }

    for (const { key, etiqueta } of claves) {
      if (audioBase64 || intentosRealizados >= MAX_INTENTOS_POR_LLAMADA) break;

      for (const modelo of modelos) {
        if (intentosRealizados >= MAX_INTENTOS_POR_LLAMADA) break;
        intentosRealizados++;
        let respuestaGemini;
        try {
          respuestaGemini = await llamarGeminiConLimite(
            `https://generativelanguage.googleapis.com/v1beta/models/${modelo}:generateContent?key=${key}`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                contents: [{ parts: [{ text: prompt }] }],
                generationConfig: {
                  responseModalities: ['AUDIO'],
                  speechConfig: {
                    voiceConfig: { prebuiltVoiceConfig: { voiceName: voz } }
                  }
                }
              })
            }
          );
        } catch (e) {
          const motivo = e && e.name === 'AbortError'
            ? `tardó más de ${TIEMPO_LIMITE_POR_INTENTO_MS / 1000}s`
            : e.message;
          console.error(`Error con el modelo de voz ${modelo} (clave ${etiqueta}): ${motivo}`);
          ultimoError = motivo;
          continue;
        }

        const datosIntento = await respuestaGemini.json();

        if (respuestaGemini.ok) {
          const parte =
            datosIntento.candidates &&
            datosIntento.candidates[0] &&
            datosIntento.candidates[0].content &&
            datosIntento.candidates[0].content.parts &&
            datosIntento.candidates[0].content.parts[0];
          audioBase64 = parte && parte.inlineData && parte.inlineData.data;
          if (audioBase64) {
            console.log(`Voz generada con clave "${etiqueta}", modelo ${modelo}`);
            break;
          }
          ultimoError = 'Gemini no devolvió un audio válido';
          continue;
        }

        console.error(`Modelo de voz ${modelo} no disponible con clave "${etiqueta}" (${respuestaGemini.status}):`, JSON.stringify(datosIntento));
        ultimoError = (datosIntento.error && datosIntento.error.message) || 'Error al generar la voz con Gemini';
        ultimoStatus = respuestaGemini.status;

        if ([400, 401, 403].includes(respuestaGemini.status)) {
          break;
        }
      }
    }

    if (!audioBase64) {
      res.status(ultimoStatus).json({ error: ultimoError || 'No se pudo generar la voz con ningún modelo disponible' });
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
