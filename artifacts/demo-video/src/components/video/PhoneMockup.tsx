import { motion } from 'framer-motion';
import { ReactNode } from 'react';

export function PhoneMockup({ 
  children, 
  className = "",
  layoutId = "phone-card",
  animate,
  initial,
  transition
}: { 
  children?: ReactNode, 
  className?: string,
  layoutId?: string,
  animate?: any,
  initial?: any,
  transition?: any
}) {
  return (
    <motion.div
      layoutId={layoutId}
      initial={initial}
      animate={animate}
      transition={transition || { type: "spring", stiffness: 300, damping: 30 }}
      className={`relative bg-brand-surface border border-brand-border rounded-[2.5rem] shadow-2xl overflow-hidden flex flex-col ${className}`}
      style={{
        boxShadow: "0 25px 50px -12px rgba(0, 0, 0, 0.7), 0 0 0 1px rgba(48, 54, 61, 0.5), inset 0 1px 1px rgba(255, 255, 255, 0.05)"
      }}
    >
      {/* Top notch/island */}
      <div className="absolute top-0 inset-x-0 h-6 flex justify-center z-50">
        <div className="w-24 h-5 bg-brand-bg rounded-b-xl" />
      </div>
      
      {/* Screen Content */}
      <div className="flex-1 w-full h-full relative z-10 pt-8 pb-4 px-4 overflow-hidden">
        {children}
      </div>
    </motion.div>
  );
}
