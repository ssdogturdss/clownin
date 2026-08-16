import { motion } from 'framer-motion';
import { PhoneMockup } from '../PhoneMockup';
import { Callout } from '../Callout';
import { useEffect, useState } from 'react';

export function SceneCoding() {
  const codeLines = [
    '<span class="text-brand-info">from</span> flask <span class="text-brand-info">import</span> Flask, jsonify',
    '',
    'app = Flask(__name__)',
    '',
    '<span class="text-brand-info">@app.route</span>(<span class="text-brand-success">"/hello"</span>)',
    '<span class="text-brand-info">def</span> <span class="text-brand-primary">hello</span>():',
    '    <span class="text-brand-info">return</span> jsonify({<span class="text-brand-success">"message"</span>: <span class="text-brand-success">"Hello World!"</span>})',
    '',
    '<span class="text-brand-info">if</span> __name__ == <span class="text-brand-success">"__main__"</span>:',
    '    app.run(host=<span class="text-brand-success">"0.0.0.0"</span>, port=5000)'
  ];

  const [visibleLines, setVisibleLines] = useState<number>(0);

  useEffect(() => {
    let currentLine = 0;
    const interval = setInterval(() => {
      if (currentLine < codeLines.length) {
        currentLine++;
        setVisibleLines(currentLine);
      } else {
        clearInterval(interval);
      }
    }, 300); // speed of line generation
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
        text="AI writes it" 
        delay={1.0} 
        className="top-[30vh] right-[20vw]" 
      />

      <motion.div
        layoutId="phone-card"
        className="z-10"
      >
        <PhoneMockup className="w-[320px] h-[640px]">
          <div className="flex flex-col h-full">
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

            {/* User Message (Persisted) */}
            <div className="mb-4">
               <div className="bg-brand-bg rounded-2xl rounded-tr-sm p-3 border border-brand-border shadow-sm inline-block max-w-[90%] float-right">
                <p className="text-brand-foreground/80 text-xs font-medium">Build me a Flask API with /hello</p>
              </div>
            </div>

            {/* AI Response Area */}
            <div className="flex-1 flex flex-col pt-2 relative">
               <div className="flex items-start gap-2 mb-2">
                 <div className="w-6 h-6 rounded-full bg-brand-primary/20 flex items-center justify-center shrink-0 mt-1">
                   <svg className="w-3.5 h-3.5 text-brand-primary" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                     <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
                   </svg>
                 </div>
                 <div className="text-xs text-brand-foreground/90 leading-relaxed font-medium pt-1.5">
                   I'll create a simple Flask application with a <code className="bg-brand-bg px-1 py-0.5 rounded text-brand-primary font-mono text-[10px]">/hello</code> endpoint.
                 </div>
               </div>

               {/* Code Block */}
               <motion.div 
                 initial={{ opacity: 0, y: 10 }}
                 animate={{ opacity: 1, y: 0 }}
                 transition={{ delay: 0.8 }}
                 className="bg-brand-bg rounded-lg border border-brand-border overflow-hidden flex-1 max-h-[320px]"
               >
                 <div className="bg-[#1c2128] px-3 py-1.5 text-[10px] text-brand-muted font-mono flex justify-between items-center border-b border-brand-border/50">
                    <span>python</span>
                    <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                    </svg>
                 </div>
                 <div className="p-3 font-mono text-[11px] leading-relaxed">
                   {codeLines.slice(0, visibleLines).map((line, idx) => (
                     <motion.div 
                       key={idx}
                       initial={{ opacity: 0, x: -5 }}
                       animate={{ opacity: 1, x: 0 }}
                       className="whitespace-pre min-h-[16px]"
                       dangerouslySetInnerHTML={{ __html: line || ' ' }}
                     />
                   ))}
                   {visibleLines < codeLines.length && (
                     <motion.div 
                        animate={{ opacity: [1, 0, 1] }} 
                        transition={{ repeat: Infinity, duration: 0.8 }}
                        className="inline-block w-2 h-3 bg-brand-primary mt-1"
                     />
                   )}
                 </div>
               </motion.div>
            </div>
            
             {/* FAB Overlay (Floating Run Button fading in late) */}
             <motion.div 
                initial={{ opacity: 0, scale: 0.8 }}
                animate={{ opacity: visibleLines >= codeLines.length ? 1 : 0, scale: visibleLines >= codeLines.length ? 1 : 0.8 }}
                transition={{ delay: 0.5 }}
                className="absolute bottom-4 right-4 z-20"
             >
                <div className="w-12 h-12 rounded-full bg-brand-primary shadow-lg shadow-brand-primary/30 flex items-center justify-center">
                  <svg className="w-5 h-5 text-white ml-1" fill="currentColor" viewBox="0 0 24 24">
                    <path d="M8 5v14l11-7z" />
                  </svg>
                </div>
             </motion.div>
          </div>
        </PhoneMockup>
      </motion.div>
    </motion.div>
  );
}
