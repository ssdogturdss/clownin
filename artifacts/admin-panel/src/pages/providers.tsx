import { useState } from "react";
import { useListProviders, useUpdateProvider, getListProvidersQueryKey } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Loader2, Cpu, KeyRound, CheckCircle2, Bot, BrainCircuit } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { toast } from "sonner";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";

export default function ProvidersPage() {
  const { data: providers, isLoading, error } = useListProviders();
  const queryClient = useQueryClient();
  const updateMutation = useUpdateProvider();

  const handleSetActive = (providerId: string) => {
    updateMutation.mutate(
      { provider: providerId, data: { isActive: true } },
      {
        onSuccess: () => {
          toast.success("Active provider updated");
          queryClient.invalidateQueries({ queryKey: getListProvidersQueryKey() });
        },
        onError: (err: any) => {
          toast.error(err.message || "Failed to update active provider");
        }
      }
    );
  };

  if (isLoading) {
    return (
      <div className="flex h-[50vh] items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (error) {
    return (
      <Alert variant="destructive" className="mt-4">
        <AlertDescription>Failed to load AI providers.</AlertDescription>
      </Alert>
    );
  }

  const activeProviderId = providers?.find(p => p.isActive)?.provider;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight text-foreground">AI Providers</h1>
        <p className="text-muted-foreground mt-2">Configure API keys and set the active model provider.</p>
      </div>

      <RadioGroup value={activeProviderId} onValueChange={handleSetActive} className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {providers?.map((provider) => (
          <ProviderCard key={provider.provider} provider={provider} />
        ))}
      </RadioGroup>
    </div>
  );
}

function ProviderCard({ provider }: { provider: any }) {
  const queryClient = useQueryClient();
  const updateMutation = useUpdateProvider();
  const [apiKey, setApiKey] = useState("");
  const [isSettingKey, setIsSettingKey] = useState(false);

  const getProviderIcon = (name: string) => {
    const n = name.toLowerCase();
    if (n.includes('openai')) return Bot;
    if (n.includes('anthropic')) return BrainCircuit;
    return Cpu;
  };

  const Icon = getProviderIcon(provider.name);

  const handleSaveKey = async () => {
    if (!apiKey.trim()) return;
    setIsSettingKey(true);
    updateMutation.mutate(
      { provider: provider.provider, data: { apiKey } },
      {
        onSuccess: () => {
          toast.success(`${provider.name} API key saved`);
          queryClient.invalidateQueries({ queryKey: getListProvidersQueryKey() });
          setApiKey("");
        },
        onError: (err: any) => {
          toast.error(err.message || "Failed to save API key");
        },
        onSettled: () => {
          setIsSettingKey(false);
        }
      }
    );
  };

  const handleClearKey = () => {
    updateMutation.mutate(
      { provider: provider.provider, data: { clearKey: true } },
      {
        onSuccess: () => {
          toast.success(`${provider.name} API key cleared`);
          queryClient.invalidateQueries({ queryKey: getListProvidersQueryKey() });
        },
        onError: (err: any) => {
          toast.error(err.message || "Failed to clear API key");
        }
      }
    );
  };

  const isActive = provider.isActive;

  return (
    <Card className={`relative transition-all duration-200 ${isActive ? 'border-primary ring-1 ring-primary/20 shadow-md shadow-primary/5 bg-card/80' : 'border-border/50 bg-card/40'}`} data-testid={`card-provider-${provider.provider}`}>
      <CardHeader className="flex flex-row items-start justify-between space-y-0 pb-2">
        <div className="flex items-center gap-3">
          <div className={`p-2 rounded-lg ${isActive ? 'bg-primary/20 text-primary' : 'bg-muted text-muted-foreground'}`}>
            <Icon className="h-6 w-6" />
          </div>
          <div>
            <CardTitle className="text-xl">{provider.name}</CardTitle>
            <CardDescription className="font-mono text-xs mt-1">{provider.baseUrl || 'Default URL'}</CardDescription>
          </div>
        </div>
        <div className="flex items-center space-x-2 bg-background p-2 rounded-md border border-border">
          <RadioGroupItem value={provider.provider} id={`radio-${provider.provider}`} data-testid={`radio-active-${provider.provider}`} />
          <label
            htmlFor={`radio-${provider.provider}`}
            className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70 cursor-pointer"
          >
            Active
          </label>
        </div>
      </CardHeader>
      <CardContent className="pt-4 border-t border-border/50 mt-4">
        {provider.hasApiKey ? (
          <div className="flex items-center justify-between bg-green-500/10 border border-green-500/20 text-green-600 dark:text-green-400 p-3 rounded-md">
            <div className="flex items-center gap-2">
              <CheckCircle2 className="h-4 w-4" />
              <span className="text-sm font-medium">Key configured ✓</span>
            </div>
            <Button variant="outline" size="sm" onClick={handleClearKey} disabled={updateMutation.isPending} className="border-green-500/30 hover:bg-green-500/20 text-green-600 dark:text-green-400" data-testid={`button-clear-key-${provider.provider}`}>
              {updateMutation.isPending && <Loader2 className="mr-2 h-3 w-3 animate-spin" />}
              Clear Key
            </Button>
          </div>
        ) : (
          <div className="flex items-center gap-2">
            <div className="relative flex-1">
              <KeyRound className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input
                type="password"
                placeholder="sk-..."
                className="pl-9 font-mono text-sm"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                data-testid={`input-apikey-${provider.provider}`}
              />
            </div>
            <Button size="sm" onClick={handleSaveKey} disabled={isSettingKey || !apiKey.trim()} data-testid={`button-save-key-${provider.provider}`}>
              {isSettingKey && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Save Key
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
