
import { GoogleGenAI, Modality } from "@google/genai";
import { decode, decodeAudioData } from "../utils/audio";

// Persistent AudioContext to avoid initialization issues in browsers
let sharedAudioContext: AudioContext | null = null;

const getAudioContext = () => {
  if (!sharedAudioContext) {
    sharedAudioContext = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });
  }
  if (sharedAudioContext.state === 'suspended') {
    sharedAudioContext.resume();
  }
  return sharedAudioContext;
};

// Fix: Always use process.env.API_KEY directly and create fresh instance inside function
export const getFashionAdvice = async (history: { role: string; message: string }[]) => {
  const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
  
  const systemInstruction = `
    You are Aria, a world-class luxury fashion stylist and designer. 
    Your tone is elegant, encouraging, and knowledgeable.
    When users ask for outfit help:
    1. Consider color theory (complementary/analogous colors).
    2. Suggest specific pairings (lower wear, shoes, accessories).
    3. Adapt to location (climate, local fashion norms) and occasion (formal, casual, party).
    4. Provide clear reasoning for your choices.
    Keep responses conversational and concise (2-3 paragraphs max).
    Do not use complex markdown formatting like excessive bolding or headers, as this will be read aloud.
  `;

  const contents = history.map(h => ({
    role: h.role === 'user' ? 'user' : 'model',
    parts: [{ text: h.message }]
  }));

  const response = await ai.models.generateContent({
    model: 'gemini-3-flash-preview',
    contents: contents,
    config: {
      systemInstruction: systemInstruction,
    },
  });

  return response.text;
};

const cleanTextForSpeech = (text: string) => {
  // Remove markdown formatting like stars, hashtags, etc. for better TTS
  return text.replace(/[*#_~]/g, '').replace(/\[.*?\]/g, '').trim();
};

// Fix: Always use process.env.API_KEY directly and create fresh instance inside function
export const getSpeech = async (text: string) => {
  const cleanedText = cleanTextForSpeech(text);
  if (!cleanedText) return null;

  try {
    const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
    
    const response = await ai.models.generateContent({
      model: "gemini-2.5-flash-preview-tts",
      contents: [{ parts: [{ text: `Aria says: ${cleanedText}` }] }],
      config: {
        responseModalities: [Modality.AUDIO],
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: { voiceName: 'Kore' }, 
          },
        },
      },
    });

    const base64Audio = response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
    return base64Audio || null;
  } catch (error) {
    console.error("TTS Generation Error:", error);
    return null;
  }
};

export const playAudio = async (base64Audio: string, onEnded?: () => void) => {
  try {
    const ctx = getAudioContext();
    const audioBuffer = await decodeAudioData(
      decode(base64Audio),
      ctx,
      24000,
      1,
    );
    const source = ctx.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(ctx.destination);
    source.onended = () => {
      if (onEnded) onEnded();
    };
    source.start();
    return source;
  } catch (error) {
    console.error("Audio Playback Error:", error);
    if (onEnded) onEnded();
    return null;
  }
};
