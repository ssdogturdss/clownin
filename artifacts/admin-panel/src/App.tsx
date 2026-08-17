import { type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ErrorBoundary } from '@/components/error-boundary';
import { Toaster } from 'sonner';
import { TooltipProvider } from '@/components/ui/tooltip';
import NotFound from '@/pages/not-found';
import {
  Route,
  Switch,
  useLocation,
  Router as WouterRouter,
} from 'wouter';

// Layout & Auth
import { RequireAuth } from '@/components/layout/require-auth';
import { Sidebar } from '@/components/layout/sidebar';

// Pages
import Login from '@/pages/login';
import Dashboard from '@/pages/dashboard';
import UsersPage from '@/pages/users';
import ProjectsPage from '@/pages/projects';
import PromoCodesPage from '@/pages/promo-codes';
import ProvidersPage from '@/pages/providers';

const queryClient = new QueryClient();

function Router() {
  return (
    <RoutedErrorBoundary>
      <Switch>
        <Route path="/login" component={Login} />
        
        <Route path="/">
          <RequireAuth>
            <Sidebar>
              <Dashboard />
            </Sidebar>
          </RequireAuth>
        </Route>
        
        <Route path="/users">
          <RequireAuth>
            <Sidebar>
              <UsersPage />
            </Sidebar>
          </RequireAuth>
        </Route>

        <Route path="/projects">
          <RequireAuth>
            <Sidebar>
              <ProjectsPage />
            </Sidebar>
          </RequireAuth>
        </Route>

        <Route path="/promo-codes">
          <RequireAuth>
            <Sidebar>
              <PromoCodesPage />
            </Sidebar>
          </RequireAuth>
        </Route>

        <Route path="/providers">
          <RequireAuth>
            <Sidebar>
              <ProvidersPage />
            </Sidebar>
          </RequireAuth>
        </Route>

        <Route>
          <RequireAuth>
            <Sidebar>
              <NotFound />
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
