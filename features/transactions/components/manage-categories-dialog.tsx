"use client";

/**
 * "Manage categories" popup opened from the Add/Edit Transaction category picker — list the
 * categories for the current kind, add a new one, rename / re-icon an existing one, or delete it.
 * Delete is a soft delete (`softDelete`), so past transactions keep their `categoryId` and the doc
 * can be restored from trash; they just render as "Uncategorized" meanwhile.
 */

import { createElement, useState } from "react";
import { Check, Loader2, Pencil, Plus, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { toast } from "@/store/toast-store";
import { useAuthStore } from "@/store/auth-store";
import { CATEGORY_ICON_FALLBACK, CATEGORY_PALETTE, type Category, type CategoryType } from "@/lib/models/category";
import { createCategoryRepository } from "@/lib/repositories/repository-factory";
import { CATEGORY_ICON_KEYS, categoryIconFor, categoryToneFor } from "@/features/transactions/hooks/use-transactions-data";

const TONE_CLASS: Record<string, string> = {
  primary: "bg-primary/12 text-primary-accent-text",
  success: "bg-success/15 text-success",
  warning: "bg-warning/20 text-warning-foreground",
  purple: "bg-purple/15 text-purple",
  expense: "bg-expense/12 text-expense",
  neutral: "bg-muted text-muted-foreground",
};

function CategoryIconBadge({ iconKey, className }: { iconKey: string; className?: string }) {
  return (
    <span className={cn("flex size-7 shrink-0 items-center justify-center", TONE_CLASS[categoryToneFor(iconKey)], className)}>
      {createElement(categoryIconFor(iconKey), { className: "size-3.5" })}
    </span>
  );
}

function IconPicker({ value, onChange }: { value: string; onChange: (key: string) => void }) {
  return (
    <div className="grid grid-cols-8 gap-1">
      {CATEGORY_ICON_KEYS.map((key) => (
        <button
          key={key}
          type="button"
          title={key.replace(/_/g, " ")}
          onClick={() => onChange(key)}
          className={cn("flex items-center justify-center border p-1", key === value ? "border-primary ring-1 ring-primary" : "border-transparent hover:border-foreground/20")}
        >
          <CategoryIconBadge iconKey={key} />
        </button>
      ))}
    </div>
  );
}

/** Name + icon form shared by "add" and "edit". */
function CategoryForm({
  initialName = "",
  initialIcon = CATEGORY_ICON_FALLBACK,
  submitLabel,
  onSubmit,
  onCancel,
}: {
  initialName?: string;
  initialIcon?: string;
  submitLabel: string;
  onSubmit: (name: string, iconKey: string) => Promise<void>;
  onCancel: () => void;
}) {
  const [name, setName] = useState(initialName);
  const [iconKey, setIconKey] = useState(initialIcon);
  const [saving, setSaving] = useState(false);

  async function submit() {
    if (!name.trim() || saving) return;
    setSaving(true);
    try {
      await onSubmit(name.trim(), iconKey);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-col gap-2 border border-foreground/15 p-2">
      <div className="flex items-center gap-2">
        <CategoryIconBadge iconKey={iconKey} />
        <Input
          autoFocus
          placeholder="Category name"
          value={name}
          maxLength={40}
          className="h-8 rounded-none"
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              e.stopPropagation();
              void submit();
            }
          }}
        />
      </div>
      <IconPicker value={iconKey} onChange={setIconKey} />
      <div className="flex justify-end gap-2">
        <Button size="sm" variant="ghost" className="rounded-none" onClick={onCancel}>
          Cancel
        </Button>
        <Button size="sm" className="rounded-none" disabled={!name.trim() || saving} onClick={() => void submit()}>
          {saving ? <Loader2 className="size-3.5 animate-spin" /> : <Check className="size-3.5" />}
          {submitLabel}
        </Button>
      </div>
    </div>
  );
}

export function ManageCategoriesDialog({
  open,
  onOpenChange,
  categories,
  type,
  onCreated,
  onDeleted,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Categories valid for the current transaction kind. */
  categories: Category[];
  type: CategoryType;
  onCreated: (id: string) => void;
  onDeleted: (id: string) => void;
}) {
  const uid = useAuthStore((s) => s.user?.uid);
  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  function nameTaken(name: string, exceptId?: string) {
    return categories.some((c) => c.id !== exceptId && c.name.toLowerCase() === name.toLowerCase());
  }

  async function handleCreate(name: string, iconKey: string) {
    if (!uid) return;
    if (nameTaken(name)) {
      toast.error("A category with that name already exists.");
      return;
    }
    try {
      const created = await createCategoryRepository(uid).createCategory({ name, type, iconKey, colorValue: CATEGORY_PALETTE[0] });
      toast.success(`Category "${name}" added.`);
      setAdding(false);
      onCreated(created.id);
    } catch {
      toast.error("Couldn't add category. Try again.");
    }
  }

  async function handleEdit(category: Category, name: string, iconKey: string) {
    if (!uid) return;
    if (nameTaken(name, category.id)) {
      toast.error("A category with that name already exists.");
      return;
    }
    try {
      await createCategoryRepository(uid).editCategory(category, { name, iconKey });
      toast.success("Category updated.");
      setEditingId(null);
    } catch {
      toast.error("Couldn't update category. Try again.");
    }
  }

  async function handleDelete(category: Category) {
    if (!uid) return;
    setDeletingId(category.id);
    try {
      await createCategoryRepository(uid).softDelete(category);
      toast.success(`Category "${category.name}" deleted.`);
      setConfirmDeleteId(null);
      onDeleted(category.id);
    } catch {
      toast.error("Couldn't delete category. Try again.");
    } finally {
      setDeletingId(null);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          setAdding(false);
          setEditingId(null);
          setConfirmDeleteId(null);
        }
        onOpenChange(next);
      }}
    >
      <DialogContent className="gap-3 rounded-none sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Manage categories</DialogTitle>
          <DialogDescription>Add, rename, change the icon of, or delete your {type} categories.</DialogDescription>
        </DialogHeader>

        {adding ? (
          <CategoryForm submitLabel="Add" onSubmit={handleCreate} onCancel={() => setAdding(false)} />
        ) : (
          <button
            type="button"
            onClick={() => {
              setAdding(true);
              setEditingId(null);
            }}
            className="flex items-center justify-center gap-1.5 border border-dashed border-foreground/25 py-2 text-xs font-semibold text-primary-accent-text hover:bg-primary/5"
          >
            <Plus className="size-3.5" />
            New category
          </button>
        )}

        <div className="flex max-h-80 flex-col gap-1 overflow-y-auto">
          {categories.length === 0 && <p className="py-4 text-center text-xs text-muted-foreground">No categories yet.</p>}
          {categories.map((c) =>
            editingId === c.id ? (
              <CategoryForm
                key={c.id}
                initialName={c.name}
                initialIcon={c.iconKey}
                submitLabel="Save"
                onSubmit={(name, iconKey) => handleEdit(c, name, iconKey)}
                onCancel={() => setEditingId(null)}
              />
            ) : (
              <div key={c.id} className="flex items-center gap-2 border border-foreground/10 px-2 py-1.5">
                <CategoryIconBadge iconKey={c.iconKey} />
                <span className="min-w-0 flex-1 truncate text-sm">{c.name}</span>
                {confirmDeleteId === c.id ? (
                  <>
                    <span className="text-xs text-muted-foreground">Delete?</span>
                    <Button size="icon-sm" variant="ghost" className="rounded-none text-danger" disabled={deletingId === c.id} onClick={() => void handleDelete(c)} aria-label="Confirm delete">
                      {deletingId === c.id ? <Loader2 className="size-3.5 animate-spin" /> : <Check className="size-3.5" />}
                    </Button>
                    <Button size="icon-sm" variant="ghost" className="rounded-none" onClick={() => setConfirmDeleteId(null)} aria-label="Cancel delete">
                      <X className="size-3.5" />
                    </Button>
                  </>
                ) : (
                  <>
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      className="rounded-none"
                      onClick={() => {
                        setEditingId(c.id);
                        setAdding(false);
                      }}
                      aria-label={`Edit ${c.name}`}
                    >
                      <Pencil className="size-3.5" />
                    </Button>
                    <Button size="icon-sm" variant="ghost" className="rounded-none text-danger" onClick={() => setConfirmDeleteId(c.id)} aria-label={`Delete ${c.name}`}>
                      <Trash2 className="size-3.5" />
                    </Button>
                  </>
                )}
              </div>
            ),
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
