import { AnimatePresence, motion } from 'framer-motion';
import { PhoneMockup } from '../PhoneMockup';
import { Callout } from '../Callout';
import { useEffect, useState } from 'react';

export function SceneRunning() {
  const terminalLines = [
    '<span class="text-brand-info">$</span> python app.py',
    '<span class="text-brand-muted">* Serving Flask app "app" (lazy loading)</span>',
    '<span class="text-brand-muted">* Environment: production</span>',
    '<span class="text-brand-destructive">  WARNING: This is a development server. Do not use it in a production deployment.</span>',
    '<span class="text-brand-muted">  Use a production WSGI server instead.</span>',
    '<span class="text-brand-muted">* Debug mode: off</span>',
    '<span class="text-brand-success">* Running on http://0.0.0.0:5000/ (Press CTRL+C to quit)</span>',
    '',
    '<span class="text-brand-info">127.0.0.1 - - [16/Aug/2023 10:15:32]</span> "GET /hello HTTP/1.1" <span class="text-brand-success">200 -</span>'
  ];

  const [visibleLines, setVisibleLines] = useState<number>(0);
  const [showTap, setShowTap] = useState(false);

  useEffect(() => {
    // Sequence: 
    // 0-1s: Wait
    // 1-1.5s: Tap animation
    // 1.5s+: Terminal starts streaming
    
    const tapTimer = setTimeout(() => setShowTap(true), 1000);
    
    const termTimer = setTimeout(() => {
      let currentLine = 0;
      const interval = setInterval(() => {
        if (currentLine < terminalLines.length) {
          currentLine++;
          setVisibleLines(currentLine);
        } else {
          clearInterval(interval);
        }
      }, 150);
      return () => clearInterval(interval);
    }, 2000);

    return () => {
      clearTimeout(tapTimer);
      clearTimeout(termTimer);
    };
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
        text="Runs on real servers" 
        delay={3.0} 
        className="top-[40vh] left-[15vw]" 
      />

      <motion.div
        layoutId="phone-card"
        className="z-10"
      >
        <PhoneMockup className="w-[320px] h-[640px]">
          <div className="flex flex-col h-full">
            {/* Header */}
            <div className="flex items-center justify-between py-2 border-b border-brand-border/50 mb-2">
              <div className="flex items-center gap-2">
                 <div className="w-6 h-6 rounded-md bg-[#1c2128] border border-brand-border flex items-center justify-center">
                  <svg className="w-3.5 h-3.5 text-brand-foreground" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 9l3 3-3 3m5 0h3M4 17h16a2 2 0 002-2V9a2 2 0 00-2-2H4a2 2 0 00-2 2v6a2 2 0 002 2z" />
                  </svg>
                </div>
                <span className="font-medium text-sm text-brand-foreground/90">Terminal</span>
              </div>
              <div className="flex items-center gap-2">
                 <div className="w-2 h-2 rounded-full bg-brand-success shadow-[0_0_8px_rgba(63,185,80,0.8)]" />
                 <span className="text-xs text-brand-success font-medium">Running</span>
              </div>
            </div>

            {/* Simulated tap on FAB (persisted from prev scene briefly) */}
            <AnimatePresence>
              {!showTap ? (
                 <motion.div 
                   key="fab"
                   exit={{ scale: 0, opacity: 0 }}
                   className="absolute bottom-4 right-4 z-20 pointer-events-none"
                 >
                    <div className="w-12 h-12 rounded-full bg-brand-primary shadow-lg shadow-brand-primary/30 flex items-center justify-center">
                      <svg className="w-5 h-5 text-white ml-1" fill="currentColor" viewBox="0 0 24 24">
                        <path d="M8 5v14l11-7z" />
                      </svg>
                    </div>
                    {/* Tap ripple */}
                    <motion.div 
                      initial={{ scale: 0.5, opacity: 0 }}
                      animate={{ scale: 2, opacity: [0, 0.5, 0] }}
                      transition={{ delay: 1, duration: 0.5 }}
                      className="absolute inset-0 rounded-full border-2 border-white/50"
                    />
                 </motion.div>
              ) : null}
            </AnimatePresence>

            {/* Terminal Area */}
            <motion.div 
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: showTap ? 1 : 0, y: showTap ? 0 : 10 }}
              transition={{ delay: 0.2 }}
              className="bg-brand-bg rounded-lg border border-brand-border overflow-hidden flex-1 mt-2 relative"
            >
               <div className="p-3 font-mono text-[11px] leading-relaxed break-all">
                   {terminalLines.slice(0, visibleLines).map((line, idx) => (
                     <motion.div 
                       key={idx}
                       initial={{ opacity: 0, x: -5 }}
                       animate={{ opacity: 1, x: 0 }}
                       className="whitespace-pre-wrap min-h-[16px] mb-1"
                       dangerouslySetInnerHTML={{ __html: line || ' ' }}
                     />
                   ))}
                   {visibleLines > 0 && visibleLines < terminalLines.length && (
                     <motion.div 
                        animate={{ opacity: [1, 0, 1] }} 
                        transition={{ repeat: Infinity, duration: 0.2 }}
                        className="inline-block w-2 h-3 bg-brand-foreground/50 mt-1 align-middle"
                     />
                   )}
                   {visibleLines >= terminalLines.length && (
                     <motion.div 
                        animate={{ opacity: [1, 0, 1] }} 
                        transition={{ repeat: Infinity, duration: 0.8 }}
                        className="inline-block w-2 h-3 bg-brand-foreground mt-1 align-middle"
                     />
                   )}
               </div>
               
               {/* Browser preview overlay appearing after server starts */}
               <AnimatePresence>
                 {visibleLines >= terminalLines.length && (
                   <motion.div 
                     initial={{ y: "100%" }}
                     animate={{ y: 0 }}
                     transition={{ type: "spring", stiffness: 300, damping: 25, delay: 0.5 }}
                     className="absolute bottom-0 inset-x-0 h-[45%] bg-brand-surface border-t border-brand-border shadow-[0_-10px_30px_rgba(0,0,0,0.5)] rounded-t-xl overflow-hidden flex flex-col"
                   >
                      <div className="bg-[#1c2128] px-3 py-2 flex items-center justify-between border-b border-brand-border/50">
                        <div className="flex gap-1.5">
                          <div className="w-2.5 h-2.5 rounded-full bg-brand-destructive/80" />
                          <div className="w-2.5 h-2.5 rounded-full bg-yellow-500/80" />
                          <div className="w-2.5 h-2.5 rounded-full bg-brand-success/80" />
                        </div>
                        <div className="bg-brand-bg px-2 py-0.5 rounded text-[9px] text-brand-muted font-mono max-w-[150px] truncate">
                          http://0.0.0.0:5000/hello
                        </div>
                        <svg className="w-3 h-3 text-brand-muted" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                        </svg>
                      </div>
                      <div className="flex-1 bg-white p-4 flex items-center justify-center">
                        <pre className="text-black font-mono text-[10px]">
                          {"{\n  \"message\": \"Hello World!\"\n}"}
                        </pre>
                      </div>
                   </motion.div>
                 )}
               </AnimatePresence>
            </motion.div>

          </div>
        </PhoneMockup>
      </motion.div>
    </motion.div>
  );
}
