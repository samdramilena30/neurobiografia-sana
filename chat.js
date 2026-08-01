// Función serverless de Vercel.
// Recibe los mensajes del chat "Habla conmigo" desde el navegador,
// llama a la API de Anthropic con la clave guardada de forma segura
// en las variables de entorno de Vercel (nunca queda visible en el código
// ni en el navegador del usuario), y devuelve la respuesta.

module.exports = async (req, res) => {
  // Permitir llamadas desde cualquier origen (útil si el sitio estático
  // vive en un dominio distinto al de esta función).
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

  if (!process.env.ANTHROPIC_API_KEY) {
    res.status(500).json({ error: 'Falta configurar ANTHROPIC_API_KEY en Vercel' });
    return;
  }

  try {
    const respuestaAnthropic = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 1000,
        system: system || '',
        messages
      })
    });

    const datos = await respuestaAnthropic.json();

    if (!respuestaAnthropic.ok) {
      res.status(respuestaAnthropic.status).json({
        error: (datos.error && datos.error.message) || 'Error al hablar con la API de Anthropic'
      });
      return;
    }

    res.status(200).json(datos);
  } catch (error) {
    res.status(500).json({ error: 'Error interno del servidor' });
  }
};
