import { motion } from 'framer-motion';
import { PhoneMockup } from '../PhoneMockup';
import { Callout } from '../Callout';
import { useEffect, useState } from 'react';

export function SceneDeploy() {
  const [phase, setPhase] = useState<number>(0);
  
  useEffect(() => {
    // 0: Initial state (fab ready)
    // 1: Tap fab
    // 2: Deploying state
    // 3: Deployed success
    
    const t1 = setTimeout(() => setPhase(1), 1000);
    const t2 = setTimeout(() => setPhase(2), 1500);
    const t3 = setTimeout(() => setPhase(3), 4000);
    
    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
      clearTimeout(t3);
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
        text="Deploy in one tap" 
        delay={4.5} 
        className="top-[35vh] right-[15vw]" 
      />

      <motion.div
        layoutId="phone-card"
        className="z-10"
      >
        <PhoneMockup className="w-[320px] h-[640px]">
          <div className="flex flex-col h-full relative">
            
            {/* Main view (blurred out during deploy) */}
            <motion.div 
              className="flex-1 flex flex-col"
              animate={{ filter: phase >= 2 ? "blur(4px)" : "blur(0px)", opacity: phase >= 2 ? 0.5 : 1 }}
            >
               {/* Header */}
              <div className="flex items-center justify-between py-2 border-b border-brand-border/50 mb-4">
                <div className="flex items-center gap-2">
                  <div className="w-6 h-6 rounded-md bg-brand-primary flex items-center justify-center">
                    <svg className="w-3.5 h-3.5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4" />
                    </svg>
                  </div>
                  <span className="font-medium text-sm text-brand-foreground/90">app.py</span>
                </div>
              </div>
              
               <div className="bg-brand-bg rounded-lg border border-brand-border p-3 flex-1 opacity-70">
                 {/* Fake code bg */}
                 <div className="w-full h-2 bg-brand-border/30 rounded mb-2 w-3/4" />
                 <div className="w-full h-2 bg-brand-border/30 rounded mb-2 w-1/2" />
                 <div className="w-full h-2 bg-brand-border/30 rounded mb-2 w-5/6" />
               </div>
            </motion.div>

            {/* Deploy FAB */}
            <motion.div 
              initial={{ scale: 1 }}
              animate={{ 
                scale: phase === 1 ? 0.9 : phase >= 2 ? 0 : 1,
                opacity: phase >= 2 ? 0 : 1
              }}
              className="absolute bottom-4 left-1/2 -translate-x-1/2 z-20"
            >
              <div className="px-6 h-12 rounded-full bg-brand-primary shadow-lg shadow-brand-primary/30 flex items-center justify-center gap-2 text-white font-medium shadow-xl">
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
                </svg>
                Deploy App
              </div>
              {/* Tap ripple */}
              {phase === 1 && (
                <motion.div 
                  initial={{ scale: 0.8, opacity: 0.8 }}
                  animate={{ scale: 1.5, opacity: 0 }}
                  transition={{ duration: 0.4 }}
                  className="absolute inset-0 rounded-full border-2 border-brand-primary bg-brand-primary/20 pointer-events-none"
                />
              )}
            </motion.div>
            
            {/* Deploy Overlay */}
            <motion.div 
              initial={{ opacity: 0, y: 50 }}
              animate={{ opacity: phase >= 2 ? 1 : 0, y: phase >= 2 ? 0 : 50 }}
              className="absolute inset-x-4 top-1/4 bottom-1/4 bg-brand-surface border border-brand-border rounded-2xl shadow-2xl z-30 flex flex-col items-center justify-center p-6 text-center"
            >
               {phase === 2 && (
                 <motion.div 
                   key="deploying"
                   initial={{ opacity: 0 }}
                   animate={{ opacity: 1 }}
                   exit={{ opacity: 0 }}
                   className="flex flex-col items-center w-full"
                 >
                   <div className="relative w-16 h-16 mb-6">
                     <motion.svg 
                       animate={{ rotate: 360 }}
                       transition={{ repeat: Infinity, duration: 2, ease: "linear" }}
                       className="w-full h-full text-brand-primary/30" 
                       viewBox="0 0 24 24"
                     >
                        <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2" fill="none" strokeDasharray="16 48" />
                     </motion.svg>
                     <div className="absolute inset-0 flex items-center justify-center">
                       <svg className="w-6 h-6 text-brand-primary" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                         <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
                       </svg>
                     </div>
                   </div>
                   
                   <h3 className="text-lg font-bold text-white mb-2">Deploying to Web</h3>
                   <div className="w-full bg-brand-bg h-1.5 rounded-full overflow-hidden">
                     <motion.div 
                       initial={{ width: "0%" }}
                       animate={{ width: "100%" }}
                       transition={{ duration: 2.5, ease: "easeInOut" }}
                       className="h-full bg-brand-primary"
                     />
                   </div>
                   
                   <div className="mt-4 text-xs text-brand-muted font-mono flex flex-col gap-1 w-full text-left">
                     <motion.div initial={{opacity:0}} animate={{opacity:1}} transition={{delay:0.2}}>Building container...</motion.div>
                     <motion.div initial={{opacity:0}} animate={{opacity:1}} transition={{delay:1.0}}>Provisioning SSL...</motion.div>
                     <motion.div initial={{opacity:0}} animate={{opacity:1}} transition={{delay:1.8}}>Starting server...</motion.div>
                   </div>
                 </motion.div>
               )}
               
               {phase === 3 && (
                 <motion.div 
                   key="success"
                   initial={{ opacity: 0, scale: 0.9 }}
                   animate={{ opacity: 1, scale: 1 }}
                   className="flex flex-col items-center w-full"
                 >
                   <motion.div 
                     initial={{ scale: 0 }}
                     animate={{ scale: 1 }}
                     transition={{ type: "spring", stiffness: 400, damping: 20 }}
                     className="w-16 h-16 rounded-full bg-brand-success/20 text-brand-success flex items-center justify-center mb-4"
                   >
                     <svg className="w-8 h-8" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                       <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
                     </svg>
                   </motion.div>
                   
                   <motion.div 
                     initial={{ opacity: 0, y: 10 }}
                     animate={{ opacity: 1, y: 0 }}
                     transition={{ delay: 0.2 }}
                     className="bg-brand-success/10 text-brand-success px-3 py-1 rounded-full text-xs font-bold uppercase tracking-wider mb-3 flex items-center gap-1.5"
                   >
                     <div className="w-1.5 h-1.5 rounded-full bg-brand-success animate-pulse" />
                     Live
                   </motion.div>
                   
                   <motion.h3 
                      initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.3 }}
                      className="text-xl font-bold text-white mb-2"
                   >
                     Deployed Successfully!
                   </motion.h3>
                   
                   <motion.div 
                      initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.6 }}
                      className="w-full bg-brand-success/5 border border-brand-success/20 rounded-lg p-3 mt-2 shadow-[0_0_15px_rgba(63,185,80,0.1)]"
                   >
                     <div className="text-[10px] text-brand-muted mb-1 uppercase font-bold tracking-wider text-left">Public URL</div>
                     <div className="text-brand-success font-mono text-xs break-all text-left flex items-center justify-between">
                       <span>https://my-flask-api.netlify.app</span>
                       <svg className="w-3.5 h-3.5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                         <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                       </svg>
                     </div>
                   </motion.div>
                 </motion.div>
               )}
            </motion.div>

          </div>
        </PhoneMockup>
      </motion.div>
    </motion.div>
  );
}
