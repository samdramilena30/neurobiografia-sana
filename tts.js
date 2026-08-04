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
    const { text } = cuerpo || {};

    if (!text || typeof text !== 'string' || !text.trim()) {
      res.status(400).json({ error: 'Falta el texto a convertir en voz' });
      return;
    }

    if (!process.env.GEMINI_API_KEY) {
      res.status(500).json({ error: 'Falta configurar GEMINI_API_KEY en Vercel' });
      return;
    }

    // Nombre de la voz de Gemini a usar. Se puede sobreescribir con la
    // variable de entorno GEMINI_TTS_VOICE en Vercel sin tocar el código.
    // "Kore" es una voz cálida y serena, adecuada para el tono de SANA.
    const voz = process.env.GEMINI_TTS_VOICE || 'Zephyr';

    // Limitar longitud para evitar solicitudes excesivamente largas
    const textoFinal = text.trim().slice(0, 2000);

    // La instrucción de estilo guía el "cómo" sin ser leída en voz alta
    // (el modelo la interpreta como dirección, no como texto a pronunciar).
    const prompt = `Di lo siguiente en español, con voz cálida, serena y pausada: "${textoFinal}"`;

    const modelo = process.env.GEMINI_TTS_MODEL || 'gemini-2.5-flash-preview-tts';

    const respuestaGemini = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${modelo}:generateContent?key=${process.env.GEMINI_API_KEY}`,
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

    const datos = await respuestaGemini.json();

    if (!respuestaGemini.ok) {
      console.error('Error de Gemini TTS:', JSON.stringify(datos));
      res.status(respuestaGemini.status).json({
        error: (datos.error && datos.error.message) || 'Error al generar la voz con Gemini'
      });
      return;
    }

    const parte =
      datos.candidates &&
      datos.candidates[0] &&
      datos.candidates[0].content &&
      datos.candidates[0].content.parts &&
      datos.candidates[0].content.parts[0];

    const audioBase64 = parte && parte.inlineData && parte.inlineData.data;

    if (!audioBase64) {
      console.error('Gemini no devolvió audio:', JSON.stringify(datos));
      res.status(500).json({ error: 'Gemini no devolvió un audio válido' });
      return;
    }

    // Gemini devuelve audio PCM en crudo (16 bits, 24000 Hz, mono), sin
    // encabezado de archivo. Los navegadores no pueden reproducir PCM crudo
    // directamente, así que le agregamos un encabezado WAV estándar.
    const pcmBuffer = Buffer.from(audioBase64, 'base64');
    const wavBuffer = agregarEncabezadoWav(pcmBuffer, 24000, 1, 16);

    res.setHeader('Content-Type', 'audio/wav');
    res.status(200).send(wavBuffer);
  } catch (error) {
    console.error('Error en la función tts.js:', error);
    res.status(500).json({ error: 'Error interno del servidor: ' + (error && error.message) });
  }
};

// Construye un encabezado WAV (formato PCM) de 44 bytes y lo antepone a los
// datos de audio en crudo, para que el navegador pueda reproducirlos.
function agregarEncabezadoWav(datosPcm, sampleRate, numCanales, bitsPorMuestra) {
  const bloqueAlineado = (numCanales * bitsPorMuestra) / 8;
  const tasaBytes = sampleRate * bloqueAlineado;
  const encabezado = Buffer.alloc(44);

  encabezado.write('RIFF', 0);
  encabezado.writeUInt32LE(36 + datosPcm.length, 4);
  encabezado.write('WAVE', 8);
  encabezado.write('fmt ', 12);
  encabezado.writeUInt32LE(16, 16);            // tamaño del sub-bloque fmt
  encabezado.writeUInt16LE(1, 20);             // formato PCM
  encabezado.writeUInt16LE(numCanales, 22);
  encabezado.writeUInt32LE(sampleRate, 24);
  encabezado.writeUInt32LE(tasaBytes, 28);
  encabezado.writeUInt16LE(bloqueAlineado, 32);
  encabezado.writeUInt16LE(bitsPorMuestra, 34);
  encabezado.write('data', 36);
  encabezado.writeUInt32LE(datosPcm.length, 40);

  return Buffer.concat([encabezado, datosPcm]);
}
