import * as React from 'react';
import { RefreshCw, ExternalLink, Lock, Loader2, RotateCcw } from 'lucide-react';
import { Button } from '@/components/ui/button';

interface PreviewPaneProps {
  serveUrl: string | null;
  isStarting: boolean;
  error: string | null;
  onRetry: () => void;
}

export function PreviewPane({ serveUrl, isStarting, error, onRetry }: PreviewPaneProps) {
  const [key, setKey] = React.useState(0);
  const [iframeReady, setIframeReady] = React.useState(false);
  const [iframeError, setIframeError] = React.useState<string | null>(null);

  const handleRefresh = () => {
    setIframeReady(false);
    setIframeError(null);
    setKey((k) => k + 1);
  };
  React.useEffect(() => {
    setIframeReady(false);
    setIframeError(null);
  }, [serveUrl]);

  return (
    <div className="flex h-full w-full flex-col border-l bg-background">
      <div className="flex items-center justify-between border-b bg-muted/20 px-3 py-2">
        <div className="flex items-center gap-2 overflow-hidden w-full max-w-[80%]">
          <div className="flex items-center gap-2 rounded-md bg-background px-3 py-1.5 text-xs border shadow-sm w-full font-mono text-muted-foreground">
            <Lock className="h-3 w-3 text-green-500/80 flex-shrink-0" />
            <span className="truncate">{serveUrl || 'localhost:3000'}</span>
          </div>
        </div>
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="icon" onClick={handleRefresh} disabled={!serveUrl || isStarting} className="h-8 w-8 text-muted-foreground hover:text-foreground">
            <RefreshCw className="h-4 w-4" />
          </Button>
        </div>
      </div>
      <div className="flex-1 bg-white relative">
        {isStarting ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 bg-muted/10 text-muted-foreground">
            <div className="flex h-16 w-16 items-center justify-center rounded-2xl border border-primary/20 bg-primary/10 shadow-inner">
              <Loader2 className="h-8 w-8 animate-spin text-primary" />
            </div>
            <div className="text-center">
              <p className="text-sm font-medium text-foreground">Starting live preview</p>
              <p className="mt-1 max-w-xs text-xs text-muted-foreground/70">Your server is coming online. This can take a few seconds.</p>
            </div>
          </div>
        ) : error || iframeError ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 bg-muted/10 text-muted-foreground">
            <div className="flex h-16 w-16 items-center justify-center rounded-2xl border border-destructive/20 bg-destructive/10 shadow-inner">
              <ExternalLink className="h-8 w-8 text-destructive/70" />
            </div>
            <div className="text-center">
              <p className="text-sm font-medium text-foreground">Preview couldn’t start</p>
              <p className="mt-1 max-w-xs text-xs text-muted-foreground/70">{error || iframeError}</p>
            </div>
            <Button variant="outline" size="sm" onClick={onRetry}>
              <RotateCcw className="mr-2 h-3.5 w-3.5" /> Try again
            </Button>
          </div>
        ) : !serveUrl ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center text-muted-foreground space-y-4 bg-muted/10">
            <div className="h-16 w-16 rounded-2xl bg-muted flex items-center justify-center mb-2 shadow-inner border border-border/50">
              <ExternalLink className="h-8 w-8 text-muted-foreground/50" />
            </div>
            <p className="text-sm font-medium">Preview Offline</p>
            <p className="text-xs text-muted-foreground/70 max-w-xs text-center">Click "Serve" in the toolbar to start the development server and view your app.</p>
          </div>
        ) : (
          <>
            {!iframeReady && (
              <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-4 bg-muted/10 text-muted-foreground">
                <Loader2 className="h-8 w-8 animate-spin text-primary" />
                <p className="text-sm">Loading live preview…</p>
              </div>
            )}
            <iframe
              key={key}
              src={serveUrl}
              className="absolute inset-0 h-full w-full border-0 bg-white"
              title="App Preview"
              sandbox="allow-scripts allow-forms allow-popups allow-modals"
              onLoad={() => setIframeReady(true)}
              onError={() => setIframeError("The preview connection was lost. Try starting it again.")}
            />
          </>
        )}
      </div>
    </div>
  );
}
