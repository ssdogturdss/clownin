import { motion } from 'framer-motion';

export function SceneClose() {
  return (
    <motion.div 
      className="absolute inset-0 flex flex-col items-center justify-center bg-brand-bg z-50"
      initial={{ clipPath: "circle(0% at 50% 50%)" }}
      animate={{ clipPath: "circle(150% at 50% 50%)" }}
      exit={{ opacity: 0 }}
      transition={{ duration: 1.2, ease: [0.16, 1, 0.3, 1] }}
    >
      <div className="absolute inset-0 dot-grid opacity-20 pointer-events-none" />
      
      <div className="relative z-10 flex flex-col items-center">
        <motion.div 
          initial={{ scale: 0.5, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          transition={{ 
            type: "spring", stiffness: 300, damping: 20, 
            delay: 0.5 
          }}
          className="mb-8 relative"
        >
          <div className="absolute inset-0 bg-brand-primary/20 blur-3xl rounded-full" />
          <div className="w-24 h-24 rounded-2xl bg-brand-surface border-2 border-brand-border shadow-2xl flex items-center justify-center relative overflow-hidden">
             <div className="absolute top-0 left-0 w-full h-1 bg-brand-primary" />
             <svg className="w-12 h-12 text-brand-primary" fill="none" viewBox="0 0 24 24" stroke="currentColor">
               <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4" />
             </svg>
          </div>
        </motion.div>
        
        <motion.h1 
          className="text-6xl md:text-8xl font-bold tracking-tighter text-white mb-4"
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.8, delay: 0.7 }}
        >
          Clownin
        </motion.h1>
        
        <motion.p 
          className="text-xl md:text-2xl text-brand-muted font-medium"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.8, delay: 1.2 }}
        >
          Build anything. <span className="text-brand-primary">From anywhere.</span>
        </motion.p>
      </div>
      
      <motion.div 
        className="absolute bottom-10 flex gap-2"
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 1.8 }}
      >
        {[0,1,2,3,4].map(i => (
          <div key={i} className="w-1.5 h-1.5 rounded-full bg-brand-border" />
        ))}
      </motion.div>
    </motion.div>
  );
}
