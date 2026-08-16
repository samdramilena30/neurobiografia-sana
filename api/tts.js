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
    const { text, idioma } = cuerpo || {};

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
    // Antes este límite era de 2000 caracteres, pensado solo para las
    // respuestas cortas del chat — pero esta misma función también genera
    // la voz completa de las prácticas guiadas, con guiones reales de
    // hasta ~6500 caracteres. Un límite bajo aquí corta el audio a mitad
    // de la práctica sin ningún aviso de error. 8000 cubre con margen los
    // guiones más largos que tenemos hoy.
    const textoFinal = text.trim().slice(0, 8000);

    // La instrucción de estilo guía el "cómo" sin ser leída en voz alta
    // (el modelo la interpreta como dirección, no como texto a pronunciar).
    // Antes siempre decía "en español", sin importar el idioma real del
    // texto — eso hacía que un guion en inglés se leyera mal o se
    // tradujera de vuelta al español. Ahora se ajusta según el idioma
    // que indique quien llama a esta función.
    const prompt = idioma === 'en'
      ? `Say the following in English, with a warm, calm, unhurried voice: "${textoFinal}"`
      : `Di lo siguiente en español, con voz cálida, serena y pausada: "${textoFinal}"`;

    // Lista de modelos de voz a intentar. Antes incluía también
    // "gemini-2.5-pro-preview-tts" como respaldo, pero ese modelo tiene
    // cuota gratuita de 0 (confirmado por Google), así que probarlo con
    // la clave gratis siempre falla — solo desperdiciaba uno de los pocos
    // intentos permitidos por llamada. Se puede seguir cambiando el
    // modelo principal con la variable GEMINI_TTS_MODEL si hiciera falta.
    const modelos = [
      process.env.GEMINI_TTS_MODEL || 'gemini-2.5-flash-preview-tts'
    ];

    // Claves a intentar, en orden: primero la gratuita de siempre. Si existe
    // GEMINI_API_KEY_PAGO (un segundo proyecto de Google con facturación
    // activada), se usa como respaldo SOLO cuando la cuota gratuita de voz
    // se agota — así casi todo el uso sigue siendo gratis, y el de pago
    // solo cubre el excedente ocasional.
    const claves = [{ key: process.env.GEMINI_API_KEY, etiqueta: 'gratis' }];
    if (process.env.GEMINI_API_KEY_PAGO) {
      claves.push({ key: process.env.GEMINI_API_KEY_PAGO, etiqueta: 'pago (respaldo)' });
    }

    let audioBase64 = null;
    let ultimoError = null;
    let ultimoStatus = 500;

    // Cada intento individual (modelo + clave) tiene un límite propio de
    // tiempo. La generación de voz de Gemini normalmente tarda más de lo
    // esperado (a veces 15-20s incluso para textos cortos), así que el
    // límite necesita ser generoso. A cambio, se prueban como máximo 2
    // combinaciones por llamada (no las 4 posibles), para que la suma
    // nunca supere el límite total que permite el servidor (60s).
    const TIEMPO_LIMITE_POR_INTENTO_MS = 25000;
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

        // Solo se detiene de inmediato (sin probar otros modelos de esta
        // misma clave) si el error es por la solicitud en sí (400) o por
        // la clave de API (401/403).
        if ([400, 401, 403].includes(respuestaGemini.status)) {
          break;
        }
      }
    }

    if (!audioBase64) {
      res.status(ultimoStatus).json({ error: ultimoError || 'No se pudo generar la voz con ningún modelo disponible' });
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
