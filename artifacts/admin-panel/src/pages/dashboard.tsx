import { useGetAdminStats } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Users, Crown, FolderOpen, Tag, Loader2 } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";

export default function Dashboard() {
  const { data: stats, isLoading, error } = useGetAdminStats();

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
        <AlertDescription>Failed to load dashboard statistics.</AlertDescription>
      </Alert>
    );
  }

  const statCards = [
    {
      title: "Total Users",
      value: stats?.userCount || 0,
      icon: Users,
      color: "text-blue-500",
    },
    {
      title: "Pro Users",
      value: stats?.proCount || 0,
      icon: Crown,
      color: "text-primary",
    },
    {
      title: "Total Projects",
      value: stats?.projectCount || 0,
      icon: FolderOpen,
      color: "text-green-500",
    },
    {
      title: "Active Promo Codes",
      value: stats?.promoCount || 0,
      icon: Tag,
      color: "text-purple-500",
    },
  ];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight text-foreground">Dashboard</h1>
        <p className="text-muted-foreground mt-2">Overview of platform metrics.</p>
      </div>

      <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-2">
        {statCards.map((stat, i) => {
          const Icon = stat.icon;
          return (
            <Card key={i} data-testid={`card-stat-${stat.title.toLowerCase().replace(' ', '-')}`}>
              <CardHeader className="flex flex-row items-center justify-between pb-2 space-y-0">
                <CardTitle className="text-sm font-medium text-muted-foreground">
                  {stat.title}
                </CardTitle>
                <Icon className={`h-5 w-5 ${stat.color}`} />
              </CardHeader>
              <CardContent>
                <div className="text-4xl font-bold" data-testid={`text-stat-value-${stat.title.toLowerCase().replace(' ', '-')}`}>
                  {stat.value.toLocaleString()}
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
