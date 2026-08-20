import * as React from 'react';
import { TerminalSquare, X, ChevronRight } from 'lucide-react';
import { TerminalLine } from './types';
import { Button } from '@/components/ui/button';

interface TerminalPaneProps {
  lines: TerminalLine[];
  isOpen: boolean;
  onClose: () => void;
}

export function TerminalPane({ lines, isOpen, onClose }: TerminalPaneProps) {
  const scrollRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [lines, isOpen]);

  if (!isOpen) return null;

  return (
    <div className="flex flex-col border-t border-zinc-800 bg-[#09090B] text-zinc-300 font-mono text-[13px] z-10 shadow-[0_-4px_24px_rgba(0,0,0,0.2)]" style={{ height: '32vh' }}>
      <div className="flex items-center justify-between border-b border-zinc-800/50 bg-[#121214] px-4 py-2">
        <div className="flex items-center gap-2">
          <TerminalSquare className="h-4 w-4 text-zinc-500" />
          <span className="font-medium tracking-wide text-zinc-400 text-xs uppercase">Terminal</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="flex h-2 w-2 rounded-full bg-green-500/80 animate-pulse mr-2"></span>
          <Button variant="ghost" size="icon" onClick={onClose} className="h-6 w-6 text-zinc-500 hover:text-zinc-100 hover:bg-zinc-800">
            <X className="h-4 w-4" />
          </Button>
        </div>
      </div>
      <div ref={scrollRef} className="flex-1 overflow-y-auto p-4 space-y-1.5 scroll-smooth">
        {lines.length === 0 ? (
          <div className="text-zinc-600/70 italic text-xs">Waiting for output...</div>
        ) : (
          lines.map((line) => (
            <div
              key={line.id}
              className={`flex items-start whitespace-pre-wrap break-all leading-relaxed ${
                line.type === 'stderr' ? 'text-red-400/90' : 
                line.type === 'system' ? 'text-blue-400/90' : 
                line.type === 'input' ? 'text-zinc-100' :
                'text-zinc-400'
              }`}
            >
              {line.type === 'input' && <ChevronRight className="h-4 w-4 mr-1 flex-shrink-0 mt-0.5 text-zinc-500" />}
              <span>{line.text}</span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
