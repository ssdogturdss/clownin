import { motion } from 'framer-motion';

export function Callout({ 
  text, 
  delay = 0,
  className = ""
}: { 
  text: string, 
  delay?: number,
  className?: string
}) {
  return (
    <motion.div
      initial={{ opacity: 0, x: -20, scale: 0.9 }}
      animate={{ opacity: 1, x: 0, scale: 1 }}
      exit={{ opacity: 0, x: 20, scale: 0.9 }}
      transition={{ 
        delay, 
        type: "spring", 
        stiffness: 400, 
        damping: 25 
      }}
      className={`absolute z-50 py-2 px-4 rounded-full bg-brand-surface/80 backdrop-blur-md border border-brand-border text-brand-foreground font-medium shadow-xl flex items-center gap-2 ${className}`}
    >
      <div className="w-2 h-2 rounded-full bg-brand-primary animate-pulse" />
      {text}
    </motion.div>
  );
}
