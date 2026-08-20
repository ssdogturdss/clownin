import * as React from 'react';

interface EditorPaneProps {
  content: string;
  onChange: (content: string) => void;
  language: string;
}

export function EditorPane({ content, onChange, language }: EditorPaneProps) {
  return (
    <div className="flex h-full w-full flex-col bg-background relative group">
      <div className="absolute top-0 right-0 px-4 py-2 text-[10px] font-mono font-bold uppercase tracking-widest text-muted-foreground/40 pointer-events-none select-none z-10">
        {language}
      </div>
      <div className="absolute left-0 top-0 bottom-0 w-12 border-r bg-muted/20 border-border/40 pointer-events-none flex flex-col items-center pt-4 text-xs font-mono text-muted-foreground/30">
        {/* Decorative line numbers for the cockpit feel */}
        {Array.from({ length: 50 }).map((_, i) => (
          <div key={i} className="h-6 flex items-center justify-center w-full">{i + 1}</div>
        ))}
      </div>
      <textarea
        value={content}
        onChange={(e) => onChange(e.target.value)}
        spellCheck={false}
        className="h-full w-full resize-none bg-transparent pl-16 pr-4 pt-4 pb-4 font-mono text-[13px] text-foreground outline-none focus:ring-0 leading-6 z-0"
        placeholder="// Write your code here..."
        style={{ tabSize: 2 }}
      />
    </div>
  );
}
