import { GoogleGenAI } from '@google/genai';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { messages } = req.body;
    
    // Inicializa la API de Gemini usando la variable de entorno de Vercel
    const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

    // Convierte el historial de mensajes al formato que espera Gemini
    const contents = messages.map(msg => ({
      role: msg.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: msg.content }]
    }));

    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: contents,
      config: {
        systemInstruction: "Eres el Asistente SANA, un espacio de paz y claridad mental...",
      }
    });

    // Forma segura y compatible de extraer el texto de la respuesta en el SDK actual
    const replyText = response.text || (response.candidates?.[0]?.content?.parts?.[0]?.text) || "";

    return res.status(200).json({ reply: replyText });
  } catch (error) {
    console.error('Error al conectar con Gemini:', error);
    return res.status(500).json({ error: 'Algo no funcionó. Intenta de nuevo en un momento.' });
  }
}
