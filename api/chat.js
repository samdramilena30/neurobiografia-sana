
      // Función serverless de Vercel.
// Recibe los mensajes del chat "Habla conmigo" desde el navegador,
// llama a la API de Gemini (Google AI Studio) con la clave guardada de forma
// segura en las variables de entorno de Vercel (nunca queda visible en el
// código ni en el navegador del usuario), y devuelve la respuesta en el
// mismo formato que ya espera el frontend.

module.exports = async (req, res) => {
  // Permitir llamadas desde cualquier origen (útil si el sitio estático
  // vive en un dominio distinto al de esta función).
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

    if (!process.env.GEMINI_API_KEY) {
      res.status(500).json({ error: 'Falta configurar GEMINI_API_KEY en Vercel' });
      return;
    }

    // Convertir el historial al formato que espera Gemini
    const contenidoGemini = messages.map((m) => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }]
    }));

    const cuerpoSolicitud = {
      contents: contenidoGemini,
      generationConfig: {
        maxOutputTokens: 2048,
        thinkingConfig: { thinkingLevel: 'low' }
      }
    };
    if (system) {
      cuerpoSolicitud.systemInstruction = { parts: [{ text: system }] };
    }

    // Lista de modelos a intentar, en orden. Si el primero está saturado,
    // fue retirado por Google, o falla por cualquier otra razón que no sea
    // un problema de la propia solicitud, se intenta automáticamente con
    // el siguiente — para que la persona nunca se quede sin respuesta.
    const modelos = [
      process.env.GEMINI_MODEL || 'gemini-3.6-flash',
      'gemini-2.0-flash',
      'gemini-flash-latest'
    ];

    let datos = null;
    let ultimoError = null;
    let ultimoStatus = 500;

    for (const modelo of modelos) {
      let respuestaGemini;
      try {
        respuestaGemini = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${modelo}:generateContent?key=` +
            process.env.GEMINI_API_KEY,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(cuerpoSolicitud)
          }
        );
      } catch (e) {
        console.error(`Error de red con el modelo ${modelo}:`, e);
        ultimoError = e.message;
        continue;
      }

      const datosIntento = await respuestaGemini.json();

      if (respuestaGemini.ok) {
        datos = datosIntento;
        break;
      }

      console.error(`Modelo ${modelo} no disponible (${respuestaGemini.status}):`, JSON.stringify(datosIntento));
      ultimoError = (datosIntento.error && datosIntento.error.message) || 'Error al hablar con la API de Gemini';
      ultimoStatus = respuestaGemini.status;

      // Solo se detiene de inmediato si el error es por la solicitud en sí
      // (400: formato inválido) o por la clave de API (401/403) — eso se
      // repetiría igual con cualquier modelo. Cualquier otro error (modelo
      // saturado, retirado, no encontrado, etc.) pasa al siguiente modelo.
      if ([400, 401, 403].includes(respuestaGemini.status)) {
        break;
      }
    }

    if (!datos) {
      res.status(ultimoStatus).json({ error: ultimoError || 'Todos los modelos de Gemini no están disponibles' });
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
      console.error('Respuesta de Gemini sin texto:', JSON.stringify(datos));
      res.status(500).json({ error: 'Gemini no devolvió una respuesta válida' });
      return;
    }

    // Devolver en el mismo formato que ya espera el frontend (data.content[0].text)
    res.status(200).json({ content: [{ text: texto }] });
  } catch (error) {
    console.error('Error en la función chat.js:', error);
    res.status(500).json({ error: 'Error interno del servidor: ' + (error && error.message) });
  }
};

