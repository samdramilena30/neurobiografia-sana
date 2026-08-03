
import { GoogleGenAI } from '@google/genai';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  try {
    const { messages, system } = req.body;
    
    if (!process.env.GEMINI_API_KEY) {
      return res.status(500).json({ error: 'Falta configurar GEMINI_API_KEY en Vercel' });
    }

    const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

    const contents = (messages || []).map(msg => ({
      role: msg.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: msg.content || '' }]
    }));

    const response = await ai.models.generateContent({
      model: 'gemini-1.5-flash',
      contents: contents,
      config: system ? { systemInstruction: system } : undefined
    });

    const textResponse = response.text || (response.candidates?.[0]?.content?.parts?.[0]?.text) || "";

    return res.status(200).json({ text: textResponse });
  } catch (error) {
    console.error("Error en la API de Gemini:", error);
    return res.status(500).json({ error: error.message || 'Error interno en el servidor' });
  }
}

