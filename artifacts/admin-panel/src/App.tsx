import { type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ErrorBoundary } from '@/components/error-boundary';
import { Toaster } from 'sonner';
import { TooltipProvider } from '@/components/ui/tooltip';
import NotFound from '@/pages/not-found';
import { Route, Switch, useLocation, Router as WouterRouter } from 'wouter';

import { Sidebar } from '@/components/layout/sidebar';
import { RequireAuth, RequireWorkspaceAuth } from '@/components/layout/require-auth';
import Dashboard from '@/pages/dashboard';
import UsersPage from '@/pages/users';
import ProjectsPage from '@/pages/projects';
import PromoCodesPage from '@/pages/promo-codes';
import ProvidersPage from '@/pages/providers';
import SessionsPage from '@/pages/sessions';
import Login from '@/pages/login';
import WorkspaceLogin from '@/pages/workspace-login';
import WorkspaceHome from '@/pages/workspace-home';
import WorkspacePage from '@/pages/workspace-page';

const queryClient = new QueryClient();

function Router() {
  return (
    <RoutedErrorBoundary>
      <Switch>
        <Route path="/workspace/login" component={WorkspaceLogin} />
        <Route path="/workspace/:id">
          <RequireWorkspaceAuth><WorkspacePage /></RequireWorkspaceAuth>
        </Route>
        <Route path="/workspace">
          <RequireWorkspaceAuth><WorkspaceHome /></RequireWorkspaceAuth>
        </Route>
        <Route path="/login" component={Login} />
        <Route>
          <RequireAuth>
            <Sidebar>
              <Switch>
          <Route path="/" component={Dashboard} />
          <Route path="/users" component={UsersPage} />
          <Route path="/projects" component={ProjectsPage} />
          <Route path="/promo-codes" component={PromoCodesPage} />
          <Route path="/providers" component={ProvidersPage} />
          <Route path="/sessions" component={SessionsPage} />
          <Route component={NotFound} />
              </Switch>
            </Sidebar>
          </RequireAuth>
        </Route>
      </Switch>
    </RoutedErrorBoundary>
  );
}

function RoutedErrorBoundary({ children }: { children: ReactNode }) {
  const [location] = useLocation();
  return <ErrorBoundary resetKey={location}>{children}</ErrorBoundary>;
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, '')}>
          <Router />
        </WouterRouter>
        <Toaster theme="dark" richColors position="top-right" />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
