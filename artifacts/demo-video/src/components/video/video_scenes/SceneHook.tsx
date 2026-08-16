import { motion } from 'framer-motion';
import { PhoneMockup } from '../PhoneMockup';

export function SceneHook() {
  return (
    <motion.div 
      className="absolute inset-0 flex flex-col items-center justify-center"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0, filter: "blur(10px)", scale: 1.05 }}
      transition={{ duration: 0.8 }}
    >
      <div className="relative z-10 flex flex-col items-center justify-center mt-[10vh]">
        <motion.div
          initial={{ y: 50, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          transition={{ duration: 1.2, ease: [0.16, 1, 0.3, 1], delay: 0.2 }}
        >
          <PhoneMockup 
            className="w-[300px] h-[600px] bg-brand-bg border-brand-border/30"
          >
            <div className="absolute inset-0 bg-gradient-to-t from-brand-primary/10 to-transparent opacity-50" />
            
            {/* Glowing clownin logo abstract */}
            <motion.div 
              className="absolute inset-0 flex items-center justify-center"
              initial={{ scale: 0.8, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              transition={{ duration: 2, delay: 1 }}
            >
              <div className="w-20 h-20 rounded-full bg-brand-primary/20 blur-xl absolute" />
              <svg className="w-12 h-12 text-brand-primary" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4" />
              </svg>
            </motion.div>
          </PhoneMockup>
        </motion.div>
        
        <div className="absolute top-[35vh] flex flex-col items-center w-full whitespace-nowrap">
          <motion.h1 
            className="text-5xl md:text-7xl font-bold tracking-tight text-white mb-2"
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.8, delay: 1.5, ease: "easeOut" }}
          >
            Your laptop...
          </motion.h1>
          <motion.h1 
            className="text-5xl md:text-7xl font-bold tracking-tight text-brand-primary"
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.8, delay: 2.2, ease: "easeOut" }}
          >
            stayed home.
          </motion.h1>
        </div>
      </div>
    </motion.div>
  );
}
