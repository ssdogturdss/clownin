import { motion } from 'framer-motion';
import { PhoneMockup } from '../PhoneMockup';
import { Callout } from '../Callout';
import { useEffect, useState } from 'react';

export function SceneInput() {
  const fullText = "Build me a Flask API with /hello";
  const [displayedText, setDisplayedText] = useState("");
  
  useEffect(() => {
    let i = 0;
    const interval = setInterval(() => {
      if (i < fullText.length) {
        setDisplayedText(fullText.substring(0, i + 1));
        i++;
      } else {
        clearInterval(interval);
      }
    }, 60);
    return () => clearInterval(interval);
  }, []);

  return (
    <motion.div 
      className="absolute inset-0 flex items-center justify-center"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0, scale: 0.95 }}
      transition={{ duration: 0.8 }}
    >
      <Callout 
        text="Type your idea" 
        delay={1.5} 
        className="top-[30vh] left-[20vw]" 
      />

      <motion.div
        layoutId="phone-card"
        initial={{ y: 50 }}
        animate={{ y: 0 }}
        transition={{ type: "spring", stiffness: 200, damping: 30 }}
        className="z-10"
      >
        <PhoneMockup className="w-[320px] h-[640px]">
          <div className="flex flex-col h-full">
            {/* Header */}
            <div className="flex items-center justify-between py-2 border-b border-brand-border/50 mb-4">
              <div className="flex items-center gap-2">
                <div className="w-6 h-6 rounded-md bg-brand-primary/20 flex items-center justify-center">
                  <svg className="w-3.5 h-3.5 text-brand-primary" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
                  </svg>
                </div>
                <span className="font-medium text-sm text-brand-foreground/90">New Project</span>
              </div>
            </div>

            {/* Chat Area */}
            <div className="flex-1 flex flex-col justify-end pb-4">
              <div className="bg-brand-bg rounded-2xl rounded-tr-sm p-4 border border-brand-border shadow-md inline-block max-w-[90%] self-end">
                <p className="text-brand-foreground text-sm font-medium">
                  {displayedText}
                  <motion.span 
                    animate={{ opacity: [1, 0, 1] }} 
                    transition={{ repeat: Infinity, duration: 0.8 }}
                    className="inline-block w-1.5 h-4 bg-brand-primary ml-0.5 align-middle"
                  />
                </p>
              </div>
            </div>

            {/* Input Bar */}
            <div className="relative mt-2">
              <div className="w-full bg-brand-bg border border-brand-border rounded-full h-12 flex items-center px-4">
                <span className="text-brand-muted text-sm">Message Clownin...</span>
                <div className="absolute right-2 top-1/2 -translate-y-1/2 w-8 h-8 rounded-full bg-brand-primary flex items-center justify-center opacity-50">
                  <svg className="w-4 h-4 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 12h14M12 5l7 7-7 7" />
                  </svg>
                </div>
              </div>
            </div>
          </div>
        </PhoneMockup>
      </motion.div>
    </motion.div>
  );
}
