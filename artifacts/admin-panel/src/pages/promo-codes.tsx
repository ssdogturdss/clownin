import { useState } from "react";
import { useListPromoCodes, useCreatePromoCode, useUpdatePromoCode, useDeletePromoCode, getListPromoCodesQueryKey } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Loader2, Plus, Copy, Pencil, Trash2, Check } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogTrigger } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from "@/components/ui/alert-dialog";
import { toast } from "sonner";
import { format } from "date-fns";

export default function PromoCodesPage() {
  const { data: promoCodes, isLoading, error } = useListPromoCodes();
  
  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight text-foreground">Promo Codes</h1>
          <p className="text-muted-foreground mt-2">Manage referral and upgrade codes.</p>
        </div>
        <CreatePromoCodeDialog />
      </div>

      {error ? (
        <Alert variant="destructive">
          <AlertDescription>Failed to load promo codes.</AlertDescription>
        </Alert>
      ) : (
        <div className="rounded-md border border-border bg-card">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Code</TableHead>
                <TableHead>Tier</TableHead>
                <TableHead className="text-right">Uses</TableHead>
                <TableHead>Expires</TableHead>
                <TableHead>Active</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                <TableRow>
                  <TableCell colSpan={6} className="h-24 text-center">
                    <Loader2 className="mx-auto h-6 w-6 animate-spin text-muted-foreground" />
                  </TableCell>
                </TableRow>
              ) : promoCodes?.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={6} className="h-24 text-center text-muted-foreground">
                    No promo codes found.
                  </TableCell>
                </TableRow>
              ) : (
                promoCodes?.map((code) => (
                  <TableRow key={code.id} data-testid={`row-promocode-${code.id}`}>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <span className="font-mono bg-muted px-2 py-1 rounded text-sm font-semibold tracking-wider">{code.code}</span>
                        <CopyButton text={code.code} />
                      </div>
                    </TableCell>
                    <TableCell className="capitalize">{code.tier}</TableCell>
                    <TableCell className="text-right text-sm">
                      <span className={code.usedCount >= code.maxUses ? "text-destructive font-semibold" : ""}>
                        {code.usedCount}
                      </span>
                      <span className="text-muted-foreground"> / {code.maxUses}</span>
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {code.expiresAt ? format(new Date(code.expiresAt), "MMM d, yyyy") : "Never"}
                    </TableCell>
                    <TableCell>
                      <ActiveToggle code={code} />
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex items-center justify-end gap-2">
                        <EditPromoCodeDialog code={code} />
                        <DeletePromoCodeDialog code={code} />
                      </div>
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

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = () => {
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
    toast.success("Copied to clipboard");
  };
  return (
    <Button variant="ghost" size="icon" className="h-6 w-6" onClick={handleCopy} data-testid={`button-copy-${text}`}>
      {copied ? <Check className="h-3 w-3 text-green-500" /> : <Copy className="h-3 w-3" />}
    </Button>
  );
}

function ActiveToggle({ code }: { code: any }) {
  const queryClient = useQueryClient();
  const updateMutation = useUpdatePromoCode();

  const handleToggle = (checked: boolean) => {
    updateMutation.mutate(
      { id: code.id, data: { isActive: checked } },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListPromoCodesQueryKey() });
          toast.success(`Promo code ${checked ? 'activated' : 'deactivated'}`);
        },
        onError: () => {
          toast.error("Failed to update status");
        }
      }
    );
  };

  return (
    <Switch 
      checked={code.isActive} 
      onCheckedChange={handleToggle} 
      disabled={updateMutation.isPending}
      data-testid={`switch-active-${code.id}`}
    />
  );
}

function CreatePromoCodeDialog() {
  const [isOpen, setIsOpen] = useState(false);
  const [tier, setTier] = useState("pro");
  const [maxUses, setMaxUses] = useState("1");
  const [expiresAt, setExpiresAt] = useState("");
  const [notes, setNotes] = useState("");
  
  const queryClient = useQueryClient();
  const createMutation = useCreatePromoCode();

  const handleCreate = () => {
    createMutation.mutate(
      {
        data: {
          tier: tier as any,
          maxUses: parseInt(maxUses, 10),
          expiresAt: expiresAt ? new Date(expiresAt).toISOString() : undefined,
          notes,
        },
      },
      {
        onSuccess: () => {
          toast.success("Promo code created successfully");
          queryClient.invalidateQueries({ queryKey: getListPromoCodesQueryKey() });
          setIsOpen(false);
          // reset
          setTier("pro");
          setMaxUses("1");
          setExpiresAt("");
          setNotes("");
        },
        onError: (err: any) => {
          toast.error(err.message || "Failed to create promo code");
        },
      }
    );
  };

  return (
    <Dialog open={isOpen} onOpenChange={setIsOpen}>
      <DialogTrigger asChild>
        <Button data-testid="button-create-promocode">
          <Plus className="mr-2 h-4 w-4" />
          Generate Code
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-[425px]">
        <DialogHeader>
          <DialogTitle>Create Promo Code</DialogTitle>
        </DialogHeader>
        <div className="grid gap-4 py-4">
          <div className="grid grid-cols-4 items-center gap-4">
            <Label htmlFor="tier-create" className="text-right">Tier</Label>
            <Select value={tier} onValueChange={setTier}>
              <SelectTrigger className="col-span-3" data-testid="select-tier-create">
                <SelectValue placeholder="Select tier" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="free">Free</SelectItem>
                <SelectItem value="pro">Pro</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="grid grid-cols-4 items-center gap-4">
            <Label htmlFor="maxUses-create" className="text-right">Max Uses</Label>
            <Input
              id="maxUses-create"
              type="number"
              value={maxUses}
              onChange={(e) => setMaxUses(e.target.value)}
              className="col-span-3"
              min="1"
              data-testid="input-maxuses-create"
            />
          </div>
          <div className="grid grid-cols-4 items-center gap-4">
            <Label htmlFor="expiresAt-create" className="text-right">Expires</Label>
            <Input
              id="expiresAt-create"
              type="date"
              value={expiresAt}
              onChange={(e) => setExpiresAt(e.target.value)}
              className="col-span-3"
              data-testid="input-expires-create"
            />
          </div>
          <div className="grid grid-cols-4 items-start gap-4">
            <Label htmlFor="notes-create" className="text-right mt-2">Notes</Label>
            <Textarea
              id="notes-create"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              className="col-span-3"
              placeholder="Optional notes..."
              data-testid="textarea-notes-create"
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setIsOpen(false)}>Cancel</Button>
          <Button onClick={handleCreate} disabled={createMutation.isPending} data-testid="button-save-promocode">
            {createMutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Generate
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function EditPromoCodeDialog({ code }: { code: any }) {
  const [isOpen, setIsOpen] = useState(false);
  const [maxUses, setMaxUses] = useState(code.maxUses.toString());
  const [expiresAt, setExpiresAt] = useState(code.expiresAt ? new Date(code.expiresAt).toISOString().split('T')[0] : "");
  const [notes, setNotes] = useState(code.notes || "");
  const [isActive, setIsActive] = useState(code.isActive);
  
  const queryClient = useQueryClient();
  const updateMutation = useUpdatePromoCode();

  const handleSave = () => {
    updateMutation.mutate(
      {
        id: code.id,
        data: {
          maxUses: parseInt(maxUses, 10),
          expiresAt: expiresAt ? new Date(expiresAt).toISOString() : null,
          notes,
          isActive,
        },
      },
      {
        onSuccess: () => {
          toast.success("Promo code updated");
          queryClient.invalidateQueries({ queryKey: getListPromoCodesQueryKey() });
          setIsOpen(false);
        },
        onError: (err: any) => {
          toast.error(err.message || "Failed to update code");
        },
      }
    );
  };

  return (
    <Dialog open={isOpen} onOpenChange={setIsOpen}>
      <DialogTrigger asChild>
        <Button variant="ghost" size="icon" className="h-8 w-8" data-testid={`button-edit-promocode-${code.id}`}>
          <Pencil className="h-4 w-4" />
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-[425px]">
        <DialogHeader>
          <DialogTitle>Edit Promo Code: {code.code}</DialogTitle>
        </DialogHeader>
        <div className="grid gap-4 py-4">
          <div className="flex items-center gap-4 justify-between border rounded-md p-3">
            <Label htmlFor="active-edit" className="cursor-pointer">Active Status</Label>
            <Switch id="active-edit" checked={isActive} onCheckedChange={setIsActive} data-testid="switch-active-edit" />
          </div>
          <div className="grid grid-cols-4 items-center gap-4">
            <Label htmlFor="maxUses-edit" className="text-right">Max Uses</Label>
            <Input
              id="maxUses-edit"
              type="number"
              value={maxUses}
              onChange={(e) => setMaxUses(e.target.value)}
              className="col-span-3"
              min={code.usedCount.toString()}
              data-testid="input-maxuses-edit"
            />
          </div>
          <div className="grid grid-cols-4 items-center gap-4">
            <Label htmlFor="expiresAt-edit" className="text-right">Expires</Label>
            <Input
              id="expiresAt-edit"
              type="date"
              value={expiresAt}
              onChange={(e) => setExpiresAt(e.target.value)}
              className="col-span-3"
              data-testid="input-expires-edit"
            />
          </div>
          <div className="grid grid-cols-4 items-start gap-4">
            <Label htmlFor="notes-edit" className="text-right mt-2">Notes</Label>
            <Textarea
              id="notes-edit"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              className="col-span-3"
              data-testid="textarea-notes-edit"
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setIsOpen(false)}>Cancel</Button>
          <Button onClick={handleSave} disabled={updateMutation.isPending} data-testid="button-save-promocode-edit">
            {updateMutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Save changes
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function DeletePromoCodeDialog({ code }: { code: any }) {
  const queryClient = useQueryClient();
  const deleteMutation = useDeletePromoCode();

  const handleDelete = () => {
    deleteMutation.mutate(
      { id: code.id },
      {
        onSuccess: () => {
          toast.success("Promo code deleted");
          queryClient.invalidateQueries({ queryKey: getListPromoCodesQueryKey() });
        },
        onError: (err: any) => {
          toast.error(err.message || "Failed to delete code");
        },
      }
    );
  };

  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button variant="ghost" size="icon" className="h-8 w-8 text-destructive hover:bg-destructive/10 hover:text-destructive" data-testid={`button-delete-promocode-${code.id}`}>
          <Trash2 className="h-4 w-4" />
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete Promo Code</AlertDialogTitle>
          <AlertDialogDescription>
            Are you sure you want to delete the promo code "{code.code}"? This will invalidate it for any future uses.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={handleDelete} className="bg-destructive text-destructive-foreground hover:bg-destructive/90" data-testid={`button-confirm-delete-promocode-${code.id}`}>
            {deleteMutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Delete
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
