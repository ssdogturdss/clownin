import { useState } from "react";
import { useListAdminUsers, useUpdateAdminUser, getListAdminUsersQueryKey } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Loader2, Search, Pencil } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogTrigger } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { toast } from "sonner";
import { format } from "date-fns";

export default function UsersPage() {
  const [searchQuery, setSearchQuery] = useState("");
  const { data: users, isLoading, error } = useListAdminUsers();
  
  const filteredUsers = users?.filter(
    (u) => 
      u.username.toLowerCase().includes(searchQuery.toLowerCase()) || 
      u.email.toLowerCase().includes(searchQuery.toLowerCase())
  ) || [];

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight text-foreground">Users</h1>
          <p className="text-muted-foreground mt-2">Manage user accounts and subscriptions.</p>
        </div>
        <div className="relative w-full md:w-80">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            type="search"
            placeholder="Search users..."
            className="pl-8"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            data-testid="input-search-users"
          />
        </div>
      </div>

      {error ? (
        <Alert variant="destructive">
          <AlertDescription>Failed to load users.</AlertDescription>
        </Alert>
      ) : (
        <div className="rounded-md border border-border bg-card">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-[80px]">ID</TableHead>
                <TableHead>Username</TableHead>
                <TableHead>Email</TableHead>
                <TableHead>Tier</TableHead>
                <TableHead className="text-right">Daily Msgs</TableHead>
                <TableHead>Joined</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                <TableRow>
                  <TableCell colSpan={7} className="h-24 text-center">
                    <Loader2 className="mx-auto h-6 w-6 animate-spin text-muted-foreground" />
                  </TableCell>
                </TableRow>
              ) : filteredUsers.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={7} className="h-24 text-center text-muted-foreground">
                    No users found.
                  </TableCell>
                </TableRow>
              ) : (
                filteredUsers.map((user) => (
                  <TableRow key={user.id} data-testid={`row-user-${user.id}`}>
                    <TableCell className="font-mono text-xs text-muted-foreground">{String(user.id).slice(0, 8)}</TableCell>
                    <TableCell className="font-medium">{user.username}</TableCell>
                    <TableCell className="text-muted-foreground">{user.email}</TableCell>
                    <TableCell>
                      <Badge variant={user.subscriptionTier === 'pro' ? 'default' : 'secondary'} className={user.subscriptionTier === 'pro' ? 'bg-primary text-primary-foreground' : ''}>
                        {user.subscriptionTier.toUpperCase()}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right font-mono text-sm">{user.dailyMessageCount}</TableCell>
                    <TableCell className="text-muted-foreground text-sm">
                      {format(new Date(user.createdAt), "MMM d, yyyy")}
                    </TableCell>
                    <TableCell className="text-right">
                      <EditUserDialog user={user} />
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}

function EditUserDialog({ user }: { user: any }) {
  const [isOpen, setIsOpen] = useState(false);
  const [tier, setTier] = useState(user.subscriptionTier);
  const [dailyMessages, setDailyMessages] = useState(user.dailyMessageCount.toString());
  
  const queryClient = useQueryClient();
  const updateMutation = useUpdateAdminUser();

  const handleSave = () => {
    updateMutation.mutate(
      {
        id: user.id,
        data: {
          subscriptionTier: tier as 'free' | 'pro',
          dailyMessageCount: parseInt(dailyMessages, 10),
        },
      },
      {
        onSuccess: () => {
          toast.success("User updated successfully");
          queryClient.invalidateQueries({ queryKey: getListAdminUsersQueryKey() });
          setIsOpen(false);
        },
        onError: (err: any) => {
          toast.error(err.message || "Failed to update user");
        },
      }
    );
  };

  return (
    <Dialog open={isOpen} onOpenChange={setIsOpen}>
      <DialogTrigger asChild>
        <Button variant="ghost" size="icon" className="h-8 w-8" data-testid={`button-edit-user-${user.id}`}>
          <Pencil className="h-4 w-4" />
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-[425px]">
        <DialogHeader>
          <DialogTitle>Edit User: {user.username}</DialogTitle>
        </DialogHeader>
        <div className="grid gap-4 py-4">
          <div className="grid grid-cols-4 items-center gap-4">
            <Label htmlFor="tier" className="text-right">Tier</Label>
            <Select value={tier} onValueChange={setTier}>
              <SelectTrigger className="col-span-3" data-testid={`select-tier-${user.id}`}>
                <SelectValue placeholder="Select tier" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="free">Free</SelectItem>
                <SelectItem value="pro">Pro</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="grid grid-cols-4 items-center gap-4">
            <Label htmlFor="dailyMessages" className="text-right">Daily Msgs</Label>
            <Input
              id="dailyMessages"
              type="number"
              value={dailyMessages}
              onChange={(e) => setDailyMessages(e.target.value)}
              className="col-span-3"
              min="0"
              data-testid={`input-daily-msgs-${user.id}`}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setIsOpen(false)}>Cancel</Button>
          <Button onClick={handleSave} disabled={updateMutation.isPending} data-testid={`button-save-user-${user.id}`}>
            {updateMutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Save changes
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
