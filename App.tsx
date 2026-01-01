
import React, { useState, useCallback, useRef, useEffect } from 'react';
import { Canvas } from '@react-three/fiber';
import { OrbitControls, Environment, ContactShadows } from '@react-three/drei';
import { GoogleGenAI, Modality } from '@google/genai';
import { Avatar } from './components/Avatar';
import { ChatWindow } from './components/ChatWindow';
import { Message } from './types';
import { decode, decodeAudioData, createBlob } from './utils/audio';

const AmbientLight = 'ambientLight' as any;

const App: React.FC = () => {
  const [messages, setMessages] = useState<Message[]>([
    { role: 'assistant', content: "Bonjour! I am Aria. Tap 'Start Live' to begin our real-time styling session. I'll help you build the perfect head-to-toe look." }
  ]);
  const [isLive, setIsLive] = useState(false);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [locationInfo, setLocationInfo] = useState<string>('Unknown location');
  
  const nextStartTimeRef = useRef(0);
  const audioSourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());
  const inputAudioCtxRef = useRef<AudioContext | null>(null);
  const outputAudioCtxRef = useRef<AudioContext | null>(null);
  const activeSessionRef = useRef<any>(null);

  // Fetch location for context-aware styling
  useEffect(() => {
    if ("geolocation" in navigator) {
      navigator.geolocation.getCurrentPosition(async (position) => {
        const { latitude, longitude } = position.coords;
        try {
          // Providing a descriptive string for the AI to understand the context
          setLocationInfo(`Approximate coordinates: Latitude ${latitude.toFixed(2)}, Longitude ${longitude.toFixed(2)}`);
        } catch (e) {
          console.error("Location error", e);
        }
      }, (err) => {
        console.warn("Location permission denied", err);
      });
    }
  }, []);

  const stopAllAudio = () => {
    audioSourcesRef.current.forEach(source => {
      try { source.stop(); } catch (e) {}
    });
    audioSourcesRef.current.clear();
    nextStartTimeRef.current = 0;
    setIsSpeaking(false);
  };

  const startLiveSession = async () => {
    if (isLive) return;

    try {
      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
      
      inputAudioCtxRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 16000 });
      outputAudioCtxRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });

      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      
      const sessionPromise = ai.live.connect({
        model: 'gemini-2.5-flash-native-audio-preview-09-2025',
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } },
          },
          systemInstruction: `
            You are Aria, an elite celebrity fashion stylist. 
            Your mission is to provide COMPLETE, HEAD-TO-TOE outfit recommendations in a real-time conversation.
            
            Current User Context (Location): ${locationInfo}
            
            When suggesting an outfit, you MUST cover these five pillars:
            1. THE TOP: Specific garment style, fabric recommendation, and color.
            2. THE BOTTOM: Cut, fit, and material.
            3. FOOTWEAR: The perfect shoes for the look and occasion.
            4. ACCESSORIES: Jewelry, bags, or eyewear to complete the aesthetic.
            5. THE STYLING TIP: A professional "finishing touch" (e.g., how to cuff, tuck, or layer).
            
            Base your choices on color theory, the user's likely local climate based on their coordinates, and the occasion they mention.
            Be concise, encouraging, and sophisticated. If the user interrupts you, stop immediately and listen.
          `,
          outputAudioTranscription: {},
          inputAudioTranscription: {},
        },
        callbacks: {
          onopen: () => {
            setIsLive(true);
            const source = inputAudioCtxRef.current!.createMediaStreamSource(stream);
            const scriptProcessor = inputAudioCtxRef.current!.createScriptProcessor(2048, 1, 1);
            
            scriptProcessor.onaudioprocess = (e) => {
              if (activeSessionRef.current) {
                const inputData = e.inputBuffer.getChannelData(0);
                const pcmBlob = createBlob(inputData);
                activeSessionRef.current.sendRealtimeInput({ media: pcmBlob });
              }
            };

            source.connect(scriptProcessor);
            scriptProcessor.connect(inputAudioCtxRef.current!.destination);
          },
          onmessage: async (message) => {
            if (message.serverContent?.interrupted) {
              stopAllAudio();
            }

            if (message.serverContent?.inputTranscription) {
              const text = message.serverContent.inputTranscription.text;
              if (text) {
                setMessages(prev => {
                  const last = prev[prev.length - 1];
                  if (last && last.role === 'user') {
                    return [...prev.slice(0, -1), { role: 'user', content: last.content + text }];
                  }
                  return [...prev, { role: 'user', content: text }];
                });
              }
            }

            if (message.serverContent?.outputTranscription) {
               const text = message.serverContent.outputTranscription.text;
               if (text) {
                 setMessages(prev => {
                   const last = prev[prev.length - 1];
                   if (last && last.role === 'assistant') {
                     return [...prev.slice(0, -1), { role: 'assistant', content: last.content + text }];
                   }
                   return [...prev, { role: 'assistant', content: text }];
                 });
               }
            }

            const audioData = message.serverContent?.modelTurn?.parts?.[0]?.inlineData?.data;
            if (audioData && outputAudioCtxRef.current) {
              setIsSpeaking(true);
              const ctx = outputAudioCtxRef.current;
              nextStartTimeRef.current = Math.max(nextStartTimeRef.current, ctx.currentTime);
              
              const buffer = await decodeAudioData(decode(audioData), ctx, 24000, 1);
              const source = ctx.createBufferSource();
              source.buffer = buffer;
              source.connect(ctx.destination);
              
              source.onended = () => {
                audioSourcesRef.current.delete(source);
                if (audioSourcesRef.current.size === 0) setIsSpeaking(false);
              };

              source.start(nextStartTimeRef.current);
              nextStartTimeRef.current += buffer.duration;
              audioSourcesRef.current.add(source);
            }
          },
          onclose: () => {
            setIsLive(false);
            stopAllAudio();
            activeSessionRef.current = null;
          },
          onerror: (e) => {
            console.error("Live Session Error:", e);
            setIsLive(false);
            activeSessionRef.current = null;
          }
        }
      });

      activeSessionRef.current = await sessionPromise;
    } catch (err) {
      console.error("Failed to start session:", err);
      setIsLive(false);
    }
  };

  const toggleSession = () => {
    if (isLive) {
      if (activeSessionRef.current) activeSessionRef.current.close();
      setIsLive(false);
    } else {
      startLiveSession();
    }
  };

  const handleSendMessage = (text: string) => {
    setMessages(prev => [...prev, { role: 'user', content: text }]);
  };

  return (
    <div className="relative w-full h-screen bg-[#050505] overflow-hidden flex flex-col md:flex-row">
      {/* 3D View Container */}
      <div className="flex-1 relative order-2 md:order-1 h-[40vh] md:h-full">
        <Canvas shadows camera={{ position: [0, 0, 5], fov: 35 }}>
          <AmbientLight intensity={0.4} />
          <Avatar isSpeaking={isSpeaking} />
          <OrbitControls enableZoom={false} minPolarAngle={Math.PI / 2.5} maxPolarAngle={Math.PI / 1.5} />
          <ContactShadows position={[0, -2, 0]} opacity={0.5} scale={10} blur={2.5} far={4} />
          <Environment preset="night" />
        </Canvas>
        
        {/* Floating Title Overlay */}
        <div className="absolute top-8 left-8 z-10">
          <h1 className="text-4xl md:text-6xl font-serif text-white tracking-tighter">ARIA</h1>
          <div className="h-1 w-12 bg-[#d4af37] mt-2"></div>
        </div>

        {/* Status Indicator */}
        {isLive && (
          <div className="absolute bottom-8 left-1/2 -translate-x-1/2 flex flex-col items-center gap-4">
            <div className={`bg-white/10 backdrop-blur-md px-6 py-3 rounded-full border border-white/20 flex items-center gap-3 shadow-lg ${isSpeaking ? 'shadow-indigo-500/20' : 'shadow-green-500/20'}`}>
              <div className="flex gap-1.5 h-4 items-center">
                <div className={`w-1 h-full bg-indigo-400 ${isSpeaking ? 'animate-[bounce_0.6s_infinite]' : 'opacity-30'}`}></div>
                <div className={`w-1 h-full bg-purple-400 ${isSpeaking ? 'animate-[bounce_0.6s_infinite] [animation-delay:-0.2s]' : 'opacity-30'}`}></div>
                <div className={`w-1 h-full bg-indigo-400 ${isSpeaking ? 'animate-[bounce_0.6s_infinite] [animation-delay:-0.4s]' : 'opacity-30'}`}></div>
              </div>
              <span className="text-[10px] text-white uppercase tracking-[0.2em] font-bold">
                {isSpeaking ? 'Aria is speaking' : 'Listening...'}
              </span>
            </div>
          </div>
        )}
      </div>

      {/* UI Container */}
      <div className="w-full md:w-[480px] p-4 md:p-8 order-1 md:order-2 flex flex-col gap-6 md:h-full justify-center relative z-20">
        <div className="flex-1 max-h-[650px]">
          <ChatWindow 
            messages={messages} 
            onSendMessage={handleSendMessage} 
            isLoading={false} 
            isLive={isLive}
            onToggleLive={toggleSession}
          />
        </div>

        {/* Quick Suggestion Chips */}
        <div className="hidden md:flex flex-wrap gap-2 justify-center">
          {['Styling for Paris', 'Wedding Guest', 'Casual Brunch'].map(tag => (
            <button 
              key={tag}
              onClick={() => handleSendMessage(`Style a complete ${tag} outfit for me.`)}
              className="text-[9px] uppercase tracking-widest font-bold px-4 py-1.5 rounded-full border border-white/10 text-white/50 hover:text-white hover:border-white/40 hover:bg-white/5 transition-all"
            >
              {tag}
            </button>
          ))}
        </div>
      </div>

      {/* Background Glows */}
      <div className="absolute top-0 right-0 w-1/2 h-full bg-gradient-to-l from-indigo-500/5 to-transparent pointer-events-none"></div>
      <div className="absolute -top-24 -left-24 w-[500px] h-[500px] bg-indigo-900/10 rounded-full blur-[160px] pointer-events-none"></div>
      <div className="absolute -bottom-24 -right-24 w-[500px] h-[500px] bg-purple-900/10 rounded-full blur-[160px] pointer-events-none"></div>
    </div>
  );
};

export default App;
