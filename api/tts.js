// Función serverless de Vercel.
// Recibe el texto que "Habla conmigo" debe pronunciar en voz alta y llama a
// Google Cloud Text-to-Speech (voz Chirp3-HD "Zephyr"), usando la cuenta de
// servicio configurada en GOOGLE_TTS_CREDENTIALS. Devuelve un audio WAV que
// el navegador reproduce directamente.

const textToSpeech = require('@google-cloud/text-to-speech');

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

    const codigoIdioma = idioma === 'en' ? 'en-US' : 'es-US';
    const nombreVoz = `${codigoIdioma}-Chirp3-HD-Zephyr`;

    let credenciales;
    try {
      credenciales = JSON.parse(process.env.GOOGLE_TTS_CREDENTIALS);
    } catch (e) {
      res.status(500).json({ error: 'GOOGLE_TTS_CREDENTIALS no es un JSON válido' });
      return;
    }

    const cliente = new textToSpeech.TextToSpeechClient({ credentials: credenciales });

    const [respuesta] = await cliente.synthesizeSpeech({
      input: { text: textoFinal },
      voice: { languageCode: codigoIdioma, name: nombreVoz },
      audioConfig: { audioEncoding: 'LINEAR16' }
    });

    if (!respuesta || !respuesta.audioContent) {
      res.status(500).json({ error: 'No se pudo generar el audio con Cloud Text-to-Speech' });
      return;
    }

    res.setHeader('Content-Type', 'audio/wav');
    res.status(200).send(respuesta.audioContent);
  } catch (error) {
    console.error('Error en la función tts.js:', error);
    res.status(500).json({ error: 'Error interno del servidor: ' + (error && error.message) });
  }
};
