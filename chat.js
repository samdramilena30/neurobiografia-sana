// Función serverless de Vercel para Google Gemini.
module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Método no permitido' });
    return;
  }

  const { messages, system } = req.body || {};

  if (!messages || !Array.isArray(messages) || messages.length === 0) {
    res.status(400).json({ error: 'Faltan mensajes' });
    return;
  }

  if (!process.env.GEMINI_API_KEY) {
    res.status(500).json({ error: 'Falta configurar GEMINI_API_KEY en Vercel' });
    return;
  }

  try {
    // Convertir el formato de mensajes al que requiere la API oficial de Gemini
    const contents = messages.map(msg => ({
      role: msg.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: msg.content }]
    }));

    const payload = { contents };
    if (system) {
      payload.system_instruction = { parts: [{ text: system }] };
    }

    const respuestaGemini = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    const datos = await respuestaGemini.json();

    if (!respuestaGemini.ok) {
      res.status(respuestaGemini.status).json({
        error: (datos.error && datos.error.message) || 'Error al hablar con la API de Gemini'
      });
      return;
    }

    // Extraer la respuesta adaptándola al formato que espera tu chat
    const textoRespuesta = datos.candidates?.[0]?.content?.parts?.[0]?.text || '';
    
    res.status(200).json({
      content: [{ text: textoRespuesta }]
    });
  } catch (error) {
    res.status(500).json({ error: 'Error interno del servidor' });
  }
};
