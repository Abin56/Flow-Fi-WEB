"use client";

import {
  AlertTriangle,
  Bell,
  BookOpen,
  Calendar,
  CalendarClock,
  CalendarRange,
  Camera,
  ChevronRight,
  CloudUpload,
  HardDrive,
  CreditCard,
  Database,
  Download,
  EyeOff,
  Fingerprint,
  Globe,
  Hash,
  HandCoins,
  Home,
  Keyboard,
  KeyRound,
  Landmark,
  Lock,
  Megaphone,
  Moon,
  Palette,
  Receipt,
  RotateCcw,
  Shield,
  ShieldCheck,
  SlidersHorizontal,
  Sun,
  Timer,
  Trash2,
  Upload,
  User,
  Users,
  Wallet,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useTheme } from "next-themes";
import { motion } from "framer-motion";
import { ClayBadge } from "@/components/clay/clay-badge";
import { ClayAvatar } from "@/components/clay/clay-avatar";
import { ClayButton } from "@/components/clay/clay-button";
import { CurrencyField } from "@/components/forms/currency-field";
import { ColorPicker } from "@/components/forms/color-picker";
import { MultiSelect } from "@/components/forms/multi-select";
import { SegmentedControl } from "@/components/forms/segmented-control";
import { SliderField } from "@/components/forms/slider-field";
import { TextField } from "@/components/forms/text-field";
import { DeleteDialog } from "@/components/dialogs/delete-dialog";
import { ScrollNav } from "@/components/layout/scroll-nav";
import { NotificationSettingsRow } from "@/components/notifications/notification-settings-row";
import { PermissionBanner } from "@/components/notifications/permission-banner";
import { SettingsCard } from "@/components/settings/settings-card";
import { SettingsDivider } from "@/components/settings/settings-divider";
import { SettingsRow } from "@/components/settings/settings-row";
import { BankLogo } from "@/components/finance/bank-logo";
import { bankById } from "@/lib/data/bank-registry";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import { updateProfile } from "firebase/auth";
import { useAccounts } from "@/hooks/use-accounts";
import { useCreditCards } from "@/hooks/use-credit-cards";
import { useLoans } from "@/hooks/use-loans";
import { usePeople } from "@/hooks/use-people";
import { formatCurrency } from "@/lib/format";
import type { Account } from "@/lib/models/account";
import type { CreditCardProfile } from "@/lib/models/credit-card";
import { useAuthStore } from "@/store/auth-store";
import { cn } from "@/lib/utils";
import { toast } from "@/store/toast-store";
import { adjacentCycleRange, cycleRangeFor, normalizeCycleStartDay, ordinalDay } from "@/lib/engines/month-cycle-range";
import { formatStatementDate } from "@/lib/engines/person-cycle-statement";
import { useProfilePhoto, useUserPreferences } from "@/features/settings/hooks/use-user-preferences";
import { resizeAvatarToDataUrl, validateAvatarFile, validateDisplayName, validatePhone } from "@/features/settings/lib/profile-validation";
import { PdfAnalyzerSetupCard } from "@/features/settings/components/pdf-analyzer-setup-card";
import { AppearanceThemes } from "@/features/settings/components/appearance-themes";
import { StorageManagement } from "@/features/storage/components/storage-management";

type SettingsTab = "profile" | "preferences" | "appearance" | "accounts" | "security" | "notifications" | "backup" | "storage" | "others";

/** One settings card — rounded, with a gentle hover lift. */
const SETTINGS_CARD =
  "rounded-[20px] border border-border/60 bg-card p-5 shadow-e1 transition-[box-shadow,border-color] duration-200 hover:border-border hover:shadow-[0_14px_34px_-18px_rgba(0,0,0,0.3)]";

/** Wraps a control that is stored but not yet read by any FlowFi screen: visibly inert, so it never implies an effect. */
function NotApplied({ children, label = "Not applied yet" }: { children: React.ReactNode; label?: string }) {
  return (
    <div className="flex items-center gap-2">
      <span className="rounded-full bg-secondary px-2 py-0.5 text-[10.5px] font-medium whitespace-nowrap text-muted-foreground">{label}</span>
      <div inert aria-disabled className="opacity-50">
        {children}
      </div>
    </div>
  );
}

const TABS: { id: SettingsTab; label: string; icon: LucideIcon }[] = [
  { id: "profile", label: "Profile", icon: User },
  { id: "preferences", label: "Preferences", icon: SlidersHorizontal },
  { id: "appearance", label: "Appearance", icon: Palette },
  { id: "accounts", label: "Accounts", icon: Wallet },
  { id: "security", label: "Security", icon: Shield },
  { id: "notifications", label: "Notifications", icon: Bell },
  { id: "backup", label: "Backup & Restore", icon: CloudUpload },
  { id: "storage", label: "Storage", icon: HardDrive },
  { id: "others", label: "Others", icon: SlidersHorizontal },
];

const CATEGORY_OPTIONS = [
  { value: "bills", label: "Bills" },
  { value: "budgets", label: "Budgets" },
  { value: "goals", label: "Goals" },
  { value: "insights", label: "AI Insights" },
];

/** Compact inline dropdown used as a SettingsRow control — plain SelectTrigger, no stacked label, since the
 *  row itself already carries the label/description on the left. Defaults to a fixed `w-44` for that inline
 *  use; pass `className="w-full"` when it's the sole control under a stacked label instead, so long option
 *  text (a timezone name, a currency label) isn't clipped into a fixed-width box. */
function RowSelect({
  value,
  onChange,
  options,
  className,
}: {
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
  className?: string;
}) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger className={cn("w-44", className)}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {options.map((o) => (
          <SelectItem key={o.value} value={o.value}>
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

const CYCLE_START_DAY_OPTIONS = Array.from({ length: 31 }, (_, i) => i + 1).map((day) => ({
  value: String(day),
  label: day === 1 ? "1st (calendar month)" : ordinalDay(day),
}));

/**
 * The ONE global accounting-cycle setting (`monthCycleStartDay`). The choice is a draft with a live preview
 * of the current / previous cycle (from the canonical `cycleRangeFor`, inclusive end dates) until Save —
 * changing it only regroups existing records into cycles; it never edits or rewrites any of them.
 */
function MonthCycleSetting({ value, onSave }: { value: number; onSave: (day: number) => void }) {
  const [draft, setDraft] = useState(value);
  const [synced, setSynced] = useState(value);
  // Follow the saved value when it loads or changes elsewhere (adjust-state-during-render).
  if (synced !== value) {
    setSynced(value);
    setDraft(value);
  }
  const now = new Date();
  const current = cycleRangeFor(draft, now);
  const previous = adjacentCycleRange(draft, current, -1);
  const fmt = (d: Date) => formatStatementDate(d, true);
  const dirty = draft !== value;
  return (
    <div className="flex flex-col gap-3 py-4">
      <div className="flex items-start gap-3">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-muted text-muted-foreground">
          <CalendarClock className="size-4.5" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-foreground">Month cycle</p>
          <p className="text-xs text-muted-foreground">
            Used by Month Cycle, People Ledger &amp; statements, Debt Planner and the Loans &amp; EMI “My EMI — Confirmed” summary. The Dashboard, Budgets and Reports stay on the calendar month; loan and EMI due dates and payments never change.
          </p>
        </div>
      </div>
      <div className="flex flex-wrap items-end gap-x-6 gap-y-3 sm:pl-12">
        <label className="flex flex-col gap-1">
          <span className="text-[11px] font-medium text-muted-foreground">Cycle starts on</span>
          <RowSelect value={String(draft)} onChange={(v) => setDraft(Number(v))} options={CYCLE_START_DAY_OPTIONS} />
        </label>
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs" aria-live="polite">
          <dt className="text-muted-foreground">Current cycle</dt>
          <dd className="font-medium tabular-nums text-foreground">
            {fmt(current.start)} → {fmt(current.end)}
          </dd>
          <dt className="text-muted-foreground">Previous cycle</dt>
          <dd className="tabular-nums text-foreground">
            {fmt(previous.start)} → {fmt(previous.end)}
          </dd>
        </dl>
        <Button
          size="sm"
          className="ml-auto"
          disabled={!dirty}
          onClick={() => {
            onSave(draft);
            toast.success("Month cycle saved", `Cycles now start on the ${ordinalDay(draft)}. No records were changed.`);
          }}
        >
          Save
        </Button>
      </div>
      {draft >= 29 && (
        <p className="text-[11px] text-muted-foreground sm:pl-12">
          In months shorter than {draft} days the cycle starts on the month&apos;s last day.
        </p>
      )}
    </div>
  );
}

function SummaryRow({ icon: Icon, iconClass, label, value, sublabel, href }: { icon: LucideIcon; iconClass: string; label: string; value: string; sublabel: string; href: string }) {
  return (
    <Link href={href} className="flex w-full items-center gap-3 rounded-xl px-1 py-2.5 text-left transition-colors hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none">
      <span className={cn("flex size-10 shrink-0 items-center justify-center rounded-full", iconClass)}>
        <Icon className="size-4" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-foreground">{label}</p>
        <p className="text-xs text-muted-foreground">{sublabel}</p>
      </div>
      <span className="shrink-0 rounded-full bg-secondary px-2.5 py-0.5 text-sm font-semibold tabular-nums text-foreground">{value}</span>
      <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
    </Link>
  );
}

/** Colored icon badge + title/description — the section heading used atop every settings card, so each
 *  card reads at a glance instead of blending into a wall of plain text headers. */
function CardHeading({ icon: Icon, iconClass, title, description }: { icon: LucideIcon; iconClass: string; title: string; description?: string }) {
  return (
    <div className="flex items-start gap-3">
      <span className={cn("flex size-10 shrink-0 items-center justify-center rounded-full", iconClass)}>
        <Icon className="size-4.5" />
      </span>
      <div className="min-w-0">
        <h2 className="text-sm font-semibold text-foreground">{title}</h2>
        {description && <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>}
      </div>
    </div>
  );
}

function ActionRow({ icon: Icon, iconClass, label, description, destructive, onClick }: { icon: LucideIcon; iconClass: string; label: string; description: string; destructive?: boolean; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className="flex w-full items-center gap-3 rounded-xl px-1 py-2.5 text-left transition-colors hover:bg-muted/50">
      <span className={cn("flex size-10 shrink-0 items-center justify-center rounded-full", iconClass)}>
        <Icon className="size-4" />
      </span>
      <div className="min-w-0 flex-1">
        <p className={cn("text-sm font-medium", destructive ? "text-expense" : "text-foreground")}>{label}</p>
        <p className="text-xs text-muted-foreground">{description}</p>
      </div>
      <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
    </button>
  );
}

export function SettingsWorkspace() {
  const [tab, setTab] = useState<SettingsTab>("profile");
  const authUser = useAuthStore((s) => s.user);
  const { data: accounts = [] } = useAccounts();
  const { data: creditCards = [] } = useCreditCards();
  const { data: loans = [] } = useLoans();
  const { data: people = [] } = usePeople();
  const { preferences, update, reset } = useUserPreferences();
  const bumpProfile = useAuthStore((s) => s.bumpProfile);
  const profilePhoto = useProfilePhoto();
  const { theme: activeTheme, setTheme: setActiveTheme } = useTheme();
  const [themeMounted, setThemeMounted] = useState(false);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- standard next-themes hydration-safe mount flag
    setThemeMounted(true);
  }, []);

  // Profile — seeded from the real signed-in Google account (this app is
  // Google Sign-In only, see `services/auth/auth-service.ts`; there is no
  // separate phone/timezone field on the Firebase Auth user, so phone stays
  // a local preference rather than fabricated account data. `fullName` stays
  // local edit-buffer state until "Save Changes" persists it via `updateProfile`.
  const [fullName, setFullName] = useState(authUser?.displayName ?? "");
  const [email] = useState(authUser?.email ?? "");
  // Name and phone are drafts saved together by "Save Changes" (validated); the phone follows the stored value when it loads.
  const [phone, setPhone] = useState(preferences.phone);
  const [syncedPhone, setSyncedPhone] = useState(preferences.phone);
  if (syncedPhone !== preferences.phone) {
    setSyncedPhone(preferences.phone);
    setPhone(preferences.phone);
  }
  const [profileErrors, setProfileErrors] = useState<{ name?: string; phone?: string }>({});
  const [savingProfile, setSavingProfile] = useState(false);
  const photoInputRef = useRef<HTMLInputElement>(null);
  const timezone = preferences.timezone;
  const setTimezone = (v: string) => update("timezone", v);
  const currency = preferences.currency;
  const setCurrency = (v: string) => update("currency", v);

  // App preferences (Profile tab quick card)
  const defaultHomeView = preferences.defaultHomeView;
  const setDefaultHomeView = (v: string) => update("defaultHomeView", v);
  const defaultAccount = preferences.defaultAccount;
  const setDefaultAccount = (v: string) => update("defaultAccount", v);
  const dateFormat = preferences.dateFormat;
  const setDateFormat = (v: string) => update("dateFormat", v);
  const numberFormat = preferences.numberFormat;
  const setNumberFormat = (v: string) => update("numberFormat", v);
  const language = preferences.language;
  const setLanguage = (v: string) => update("language", v);
  const startWeekOn = preferences.startWeekOn;
  const setStartWeekOn = (v: string) => update("startWeekOn", v);
  const monthCycleStartDay = normalizeCycleStartDay(preferences.monthCycleStartDay);
  const setMonthCycleStartDay = (day: number) => update("monthCycleStartDay", normalizeCycleStartDay(day));

  // Security (Profile tab quick card)
  const setBiometricLock = (v: boolean) => update("biometricLock", v);
  const autoLockMinutes = preferences.autoLockMinutes;
  const setAutoLockMinutes = (v: string) => update("autoLockMinutes", v);
  const privacyMode = preferences.privacyMode;
  const setPrivacyMode = (v: boolean) => update("privacyMode", v);

  // Notifications (Profile tab quick card)
  const transactionAlerts = preferences.transactionAlerts;
  const setTransactionAlerts = (v: boolean) => update("transactionAlerts", v);
  const billReminders = preferences.billReminders;
  const setBillReminders = (v: boolean) => update("billReminders", v);
  const emiReminders = preferences.emiReminders;
  const setEmiReminders = (v: boolean) => update("emiReminders", v);
  const budgetAlerts = preferences.budgetAlerts;
  const setBudgetAlerts = (v: boolean) => update("budgetAlerts", v);
  const marketingUpdates = preferences.marketingUpdates;
  const setMarketingUpdates = (v: boolean) => update("marketingUpdates", v);

  // Preferences tab (deeper)
  const monthlyBudget = preferences.monthlyBudget;
  const setMonthlyBudget = (v: number) => update("monthlyBudget", v);
  const betaFeatures = preferences.betaFeatures;
  const setBetaFeatures = (v: boolean) => update("betaFeatures", v);
  // Theme is the live next-themes value (the same one the top bar toggles), not a stored-but-unused preference.
  const theme = themeMounted ? (activeTheme ?? "system") : "system";
  const setTheme = (v: string) => setActiveTheme(v);
  const accentColor = preferences.accentColor;
  const setAccentColor = (v: string) => update("accentColor", v);
  const density = preferences.density;
  const setDensity = (v: number) => update("density", v);

  // Security tab (deeper)

  // Notifications tab (deeper)
  const [pushPermission, setPushPermission] = useState<NotificationPermission | "unsupported">("default");
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- reads the browser's real permission after mount
    setPushPermission(typeof window !== "undefined" && "Notification" in window ? Notification.permission : "unsupported");
  }, []);
  const digestCategories = preferences.digestCategories;
  const setDigestCategories = (v: string[]) => update("digestCategories", v);
  const channels = preferences.channels;
  const marketingEmails = preferences.marketingEmails;
  const setMarketingEmails = (v: boolean) => update("marketingEmails", v);

  // Danger zone
  const [resetOpen, setResetOpen] = useState(false);

  function setChannel(row: string, key: string, value: boolean) {
    update("channels", { ...channels, [row]: { ...channels[row], [key]: value } });
  }

  const totalBalance = (accounts as Account[]).reduce((sum, a) => sum + a.currentBalance, 0);

  async function handleSaveProfile() {
    if (!authUser) return;
    const name = validateDisplayName(fullName);
    const phoneCheck = validatePhone(phone);
    const errors = { name: name.error ?? undefined, phone: phoneCheck.error ?? undefined };
    setProfileErrors(errors);
    if (errors.name || errors.phone) return;
    setSavingProfile(true);
    try {
      if (name.value !== (authUser.displayName ?? "")) {
        await updateProfile(authUser, { displayName: name.value });
        bumpProfile();
      }
      update("phone", phoneCheck.value);
      setFullName(name.value);
      setPhone(phoneCheck.value);
      toast.success("Profile saved", "Your name and phone number were updated.");
    } catch {
      toast.error("Couldn't save profile", "Please check your connection and try again.");
    } finally {
      setSavingProfile(false);
    }
  }

  async function handlePhotoPicked(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    const problem = validateAvatarFile(file);
    if (problem) {
      toast.error("Can't use that photo", problem);
      return;
    }
    try {
      update("avatarDataUrl", await resizeAvatarToDataUrl(file));
      toast.success("Photo updated", "Saved on this device.");
    } catch {
      toast.error("Couldn't read that image", "Try a JPG or PNG.");
    }
  }

  function showUnavailable(what: string) {
    toast.info(`${what} isn't available in the app yet`, "Email abinjohn.dev@gmail.com and we'll handle it manually.");
  }

  async function enablePush() {
    if (pushPermission === "unsupported") {
      toast.error("Notifications aren't supported in this browser");
      return;
    }
    const result = await Notification.requestPermission();
    setPushPermission(result);
    if (result === "granted") toast.success("Browser notifications allowed");
    else toast.error("Notifications are blocked", "Allow them for this site in your browser settings.");
  }

  return (
    <div className="grid grid-cols-1 gap-5 px-1 xl:grid-cols-12">
      <div className="flex flex-col gap-5 xl:col-span-8">
        <div>
          <h1 className="font-heading text-2xl font-bold tracking-tight text-foreground">Settings</h1>
          <p className="mt-1 text-sm text-muted-foreground">Manage your preferences and app configurations</p>
        </div>

        {/* Profile hero — who you are and what FlowFi holds for you (counts only). */}
        <section aria-label="Your profile" className="relative overflow-hidden rounded-[20px] bg-gradient-to-br from-[#1d2330] via-[#262e3d] to-[#323b4d] px-5 py-5 text-white shadow-e1 sm:px-6">
          <span aria-hidden className="pointer-events-none absolute -top-20 -right-16 size-60 rounded-full bg-primary/25 blur-3xl" />
          <span aria-hidden className="pointer-events-none absolute -bottom-24 -left-16 size-52 rounded-full border border-white/10" />
          <div className="relative flex flex-wrap items-center gap-4">
            <span className="rounded-full ring-2 ring-primary/70 ring-offset-2 ring-offset-[#262e3d]">
              <ClayAvatar src={profilePhoto} name={authUser?.displayName ?? fullName} size={60} />
            </span>
            <div className="min-w-0 flex-1">
              <p className="truncate font-heading text-xl leading-tight font-semibold">{authUser?.displayName || "Your profile"}</p>
              <p className="truncate text-sm text-white/70">{email || "Signed in"}</p>
            </div>
          </div>
          <dl className="relative mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
            {[
              { label: "Accounts", value: String(accounts.length) },
              { label: "Total balance", value: formatCurrency(totalBalance) },
              { label: "Credit cards", value: String(creditCards.length) },
              { label: "People", value: String(people.length) },
            ].map((m) => (
              <div key={m.label} className="min-w-0 rounded-[12px] bg-white/10 px-3 py-2 ring-1 ring-white/15 backdrop-blur-sm">
                <dt className="truncate text-[10.5px] font-semibold tracking-[0.06em] text-white/70 uppercase">{m.label}</dt>
                <dd className="truncate text-[15px] font-bold tabular-nums">{m.value}</dd>
              </div>
            ))}
          </dl>
        </section>

        <div role="tablist" aria-label="Settings sections" className="flex gap-1 overflow-x-auto rounded-full border border-border bg-card p-1 shadow-e1 [scrollbar-width:none]">
          {TABS.map((t) => {
            const active = tab === t.id;
            return (
              <button
                key={t.id}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => setTab(t.id)}
                className={cn(
                  "relative flex h-9 shrink-0 items-center gap-1.5 rounded-full px-3.5 text-sm outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
                  active ? "font-semibold text-primary-foreground" : "font-medium text-foreground/70 hover:bg-secondary hover:text-foreground",
                )}
              >
                {active && (
                  <motion.span
                    layoutId="settings-tab"
                    aria-hidden
                    className="absolute inset-0 rounded-full bg-primary ring-1 ring-primary-accent-text/40"
                    transition={{ type: "spring", stiffness: 500, damping: 40 }}
                  />
                )}
                <t.icon className="relative size-4" />
                <span className="relative">{t.label}</span>
              </button>
            );
          })}
        </div>

        {tab === "profile" && (
          <div className="flex flex-col gap-5">
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
              <div className={SETTINGS_CARD}>
                <CardHeading icon={User} iconClass="bg-primary/12 text-primary-accent-text" title="Profile Information" description="Update your personal information and profile details." />

                <div className="mt-4 flex items-center gap-4">
                  <div className="relative">
                    <ClayAvatar src={profilePhoto} name={authUser?.displayName ?? fullName} size={72} />
                    <button
                      type="button"
                      aria-label="Change photo"
                      onClick={() => photoInputRef.current?.click()}
                      className="absolute -right-1 -bottom-1 flex size-6 items-center justify-center rounded-full border-2 border-card bg-primary text-primary-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <Camera className="size-3" />
                    </button>
                    <input ref={photoInputRef} type="file" accept="image/*" hidden aria-label="Profile photo file" onChange={(e) => void handlePhotoPicked(e)} />
                  </div>
                  <div className="flex flex-col items-start gap-1 text-xs text-muted-foreground">
                    <span>JPG, PNG or WebP up to 5 MB. Saved on this device.</span>
                    {preferences.avatarDataUrl && (
                      <button type="button" onClick={() => update("avatarDataUrl", "")} className="font-medium text-foreground underline-offset-2 hover:underline">
                        Remove photo (use Google photo)
                      </button>
                    )}
                  </div>
                </div>

                {/* Real <form> (display: contents): Enter in a profile field saves like "Save Changes". */}
                <form
                  className="contents"
                  noValidate
                  onSubmit={(e) => {
                    e.preventDefault();
                    void handleSaveProfile();
                  }}
                >
                <div className="mt-4 flex flex-col gap-3">
                  <TextField label="Full Name" value={fullName} maxLength={80} error={profileErrors.name} onChange={(e) => { setFullName(e.target.value); setProfileErrors((p) => ({ ...p, name: undefined })); }} />
                  <TextField label="Email Address" type="email" value={email} disabled onChange={() => {}} />
                  <TextField label="Phone Number" type="tel" inputMode="tel" optional value={phone} error={profileErrors.phone} onChange={(e) => { setPhone(e.target.value); setProfileErrors((p) => ({ ...p, phone: undefined })); }} />
                  <div className="flex flex-col gap-1.5">
                    <span className="flex items-center gap-2 text-sm font-medium text-foreground">Timezone <span className="rounded-full bg-secondary px-2 py-0.5 text-[10.5px] font-medium text-muted-foreground">Not applied yet</span></span>
                    <div inert aria-disabled className="opacity-50"><RowSelect
                      value={timezone}
                      onChange={setTimezone}
                      className="w-full"
                      options={[
                        { value: "ist", label: "(GMT+05:30) India Standard Time" },
                        { value: "utc", label: "(GMT+00:00) UTC" },
                        { value: "pst", label: "(GMT-08:00) Pacific Time" },
                      ]}
                    /></div>
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <span className="flex items-center gap-2 text-sm font-medium text-foreground">Currency <span className="rounded-full bg-secondary px-2 py-0.5 text-[10.5px] font-medium text-muted-foreground">Fixed to INR (₹)</span></span>
                    <div inert aria-disabled className="opacity-50"><RowSelect
                      value={currency}
                      onChange={setCurrency}
                      className="w-full"
                      options={[
                        { value: "inr", label: "INR - Indian Rupee (₹)" },
                        { value: "usd", label: "USD - US Dollar ($)" },
                        { value: "eur", label: "EUR - Euro (€)" },
                      ]}
                    /></div>
                  </div>
                </div>

                <div className="mt-4 flex justify-end">
                  <ClayButton type="submit" disabled={savingProfile}>{savingProfile ? "Saving…" : "Save Changes"}</ClayButton>
                </div>
                </form>
              </div>

              <div className={SETTINGS_CARD}>
                <CardHeading icon={SlidersHorizontal} iconClass="bg-purple/15 text-purple" title="App Preferences" description="Customize the app to match your workflow." />

                <div className="mt-2 flex flex-col divide-y divide-border/60">
                  <SettingsRow
                    icon={<Home className="size-4.5" />}
                    label="Default Home View"
                    description="Choose your default landing page"
                    control={<NotApplied><RowSelect
                        value={defaultHomeView}
                        onChange={setDefaultHomeView}
                        options={[
                          { value: "dashboard", label: "Dashboard" },
                          { value: "transactions", label: "Transactions" },
                          { value: "budgets", label: "Budgets" },
                        ]}
                      /></NotApplied>}
                  />
                  <SettingsRow
                    icon={<Wallet className="size-4.5" />}
                    label="Default Account"
                    description="FlowFi never pre-selects an account — you choose the payment source each time"
                    control={<NotApplied><RowSelect
                        value={defaultAccount}
                        onChange={setDefaultAccount}
                        options={[{ value: "select", label: "Select Account" }, ...(accounts as Account[]).map((a) => ({ value: a.id, label: a.name }))]}
                      /></NotApplied>}
                  />
                  <SettingsRow
                    icon={<Calendar className="size-4.5" />}
                    label="Date Format"
                    description="Choose your preferred date format"
                    control={<NotApplied><RowSelect
                        value={dateFormat}
                        onChange={setDateFormat}
                        options={[
                          { value: "dd-mmm-yyyy", label: "DD MMM YYYY" },
                          { value: "mm-dd-yyyy", label: "MM/DD/YYYY" },
                          { value: "yyyy-mm-dd", label: "YYYY-MM-DD" },
                        ]}
                      /></NotApplied>}
                  />
                  <SettingsRow
                    icon={<Hash className="size-4.5" />}
                    label="Number Format"
                    description="Choose number and currency format"
                    control={<NotApplied><RowSelect
                        value={numberFormat}
                        onChange={setNumberFormat}
                        options={[
                          { value: "indian", label: "1,23,456.78" },
                          { value: "international", label: "123,456.78" },
                        ]}
                      /></NotApplied>}
                  />
                  <SettingsRow
                    icon={<Globe className="size-4.5" />}
                    label="Language"
                    description="Select your preferred language"
                    control={<NotApplied><RowSelect
                        value={language}
                        onChange={setLanguage}
                        options={[
                          { value: "en", label: "English" },
                          { value: "hi", label: "Hindi" },
                        ]}
                      /></NotApplied>}
                  />
                  <SettingsRow
                    icon={<CalendarRange className="size-4.5" />}
                    label="Start Week On"
                    description="Choose the first day of the week"
                    control={<NotApplied><RowSelect
                        value={startWeekOn}
                        onChange={setStartWeekOn}
                        options={[
                          { value: "monday", label: "Monday" },
                          { value: "sunday", label: "Sunday" },
                        ]}
                      /></NotApplied>}
                  />
                  <MonthCycleSetting value={monthCycleStartDay} onSave={setMonthCycleStartDay} />
                </div>
              </div>
            </div>

            <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
              <div className={SETTINGS_CARD}>
                <CardHeading icon={Shield} iconClass="bg-warning/20 text-warning-foreground" title="Security Settings" description="Manage your security and privacy preferences." />
                <div className="mt-2 flex flex-col divide-y divide-border/60">
                  <SettingsRow
                    icon={<KeyRound className="size-4.5" />}
                    label="Change Password"
                    description="Update your account password"
                    control={
                      <button type="button" aria-label="Open security settings" onClick={() => setTab("security")} className="text-muted-foreground">
                        <ChevronRight className="size-4" />
                      </button>
                    }
                  />
                  <SettingsRow
                    icon={<Fingerprint className="size-4.5" />}
                    label="Biometric Lock"
                    description="Use fingerprint/face to unlock app"
                    control={<NotApplied label="Not available on web"><Switch checked={false} onCheckedChange={setBiometricLock} /></NotApplied>}
                  />
                  <SettingsRow
                    icon={<Timer className="size-4.5" />}
                    label="Auto Lock"
                    description="Automatically lock the app"
                    control={<NotApplied><RowSelect
                        value={autoLockMinutes}
                        onChange={setAutoLockMinutes}
                        options={[
                          { value: "1", label: "1 minute" },
                          { value: "5", label: "5 minutes" },
                          { value: "15", label: "15 minutes" },
                        ]}
                      /></NotApplied>}
                  />
                  <SettingsRow
                    icon={<EyeOff className="size-4.5" />}
                    label="Privacy Mode"
                    description="Hide sensitive data in previews"
                    control={<NotApplied><Switch checked={privacyMode} onCheckedChange={setPrivacyMode} /></NotApplied>}
                  />
                </div>
              </div>

              <div className={SETTINGS_CARD}>
                <CardHeading icon={Bell} iconClass="bg-success/15 text-success" title="Notifications" description="Choose what you want to hear about. Saved on this device — delivery isn't live yet." />
                <div className="mt-2 flex flex-col divide-y divide-border/60">
                  <SettingsRow icon={<Bell className="size-4.5" />} label="Transaction Alerts" description="Get notified for new transactions" control={<Switch checked={transactionAlerts} onCheckedChange={setTransactionAlerts} />} />
                  <SettingsRow icon={<Receipt className="size-4.5" />} label="Bill Reminders" description="Reminders for upcoming bills" control={<Switch checked={billReminders} onCheckedChange={setBillReminders} />} />
                  <SettingsRow icon={<CalendarClock className="size-4.5" />} label="EMI Reminders" description="Reminders for upcoming EMIs" control={<Switch checked={emiReminders} onCheckedChange={setEmiReminders} />} />
                  <SettingsRow icon={<Wallet className="size-4.5" />} label="Budget Alerts" description="Alerts for budget limits" control={<Switch checked={budgetAlerts} onCheckedChange={setBudgetAlerts} />} />
                  <SettingsRow icon={<Megaphone className="size-4.5" />} label="Marketing Updates" description="Updates about new features" control={<Switch checked={marketingUpdates} onCheckedChange={setMarketingUpdates} />} />
                </div>
              </div>

              <div className={SETTINGS_CARD}>
                <CardHeading icon={CloudUpload} iconClass="bg-primary/12 text-primary-accent-text" title="Backup & Restore" />
                <p className="mt-3 text-xs text-muted-foreground">
                  Your data is already saved to the cloud automatically — every account, transaction, and budget
                  syncs to FlowFi&apos;s servers in real time, so there&apos;s no separate backup step needed.
                </p>
                <p className="mt-3 text-xs text-muted-foreground">
                  Backing up to Google Drive isn&apos;t available yet — it needs a Google Drive access request this
                  app doesn&apos;t currently ask for.
                </p>
              </div>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-4 rounded-2xl border border-border/50 bg-muted/30 px-5 py-4">
              <div className="flex items-center gap-3">
                <ShieldCheck className="size-5 shrink-0 text-success" />
                <div>
                  <p className="text-sm font-semibold text-foreground">Your data is secure and encrypted</p>
                  <p className="text-xs text-muted-foreground">We use bank-level security to protect your financial data and keep it private.</p>
                </div>
              </div>
            </div>
          </div>
        )}

        {tab === "preferences" && (
          <div className="flex flex-col gap-4">
            <SettingsCard>
              <CardHeading icon={Wallet} iconClass="bg-primary/12 text-primary-accent-text" title="Budgeting" />
              <div className="mt-3">
                <NotApplied><CurrencyField label="Default monthly budget" value={monthlyBudget} onChange={setMonthlyBudget} description="Used as the starting point for new budget cycles." /></NotApplied>
              </div>
            </SettingsCard>

            <SettingsCard noPadding>
              <SettingsRow
                icon={<SlidersHorizontal className="size-4.5" />}
                label="Early access features"
                description="Try new FlowFi features before general release"
                control={<NotApplied label="No early features yet"><Switch checked={betaFeatures} onCheckedChange={setBetaFeatures} /></NotApplied>}
              />
            </SettingsCard>

            <SettingsCard>
              <CardHeading icon={Sun} iconClass="bg-warning/20 text-warning-foreground" title="Theme" />
              <div className="mt-3">
              <SegmentedControl
                value={theme}
                onChange={setTheme}
                options={[
                  { value: "light", label: "Light" },
                  { value: "dark", label: "Dark" },
                  { value: "system", label: "System" },
                ]}
              />
              </div>
            </SettingsCard>

            <SettingsCard>
              <CardHeading icon={Palette} iconClass="bg-purple/15 text-purple" title="Accent color" />
              <div className="mt-3">
                <NotApplied><ColorPicker value={accentColor} onChange={setAccentColor} /></NotApplied>
              </div>
            </SettingsCard>

            <SettingsCard>
              <CardHeading icon={SlidersHorizontal} iconClass="bg-success/15 text-success" title="Density" />
              <div className="mt-3">
                <NotApplied><SliderField label="Interface density" value={density} onChange={setDensity} formatValue={(v) => (v < 33 ? "Compact" : v < 66 ? "Comfortable" : "Spacious")} /></NotApplied>
              </div>
            </SettingsCard>
          </div>
        )}

        {tab === "appearance" && <AppearanceThemes />}

        {tab === "accounts" && (
          <div className="flex flex-col gap-4">
            <SettingsCard noPadding>
              <div className="px-5 pt-4 pb-1">
                <CardHeading icon={Landmark} iconClass="bg-primary/12 text-primary-accent-text" title="Bank & Cash Accounts" />
              </div>
              {(accounts as Account[]).map((a, i) => (
                <div key={a.id}>
                  {i > 0 && <SettingsDivider />}
                  <SettingsRow
                    icon={<BankLogo bankId={a.bankId} size={22} shape="square" />}
                    label={a.name}
                    description={bankById(a.bankId)?.name ?? "No institution"}
                    control={<span className="font-mono text-sm font-semibold tabular-nums text-foreground">{formatCurrency(a.currentBalance)}</span>}
                  />
                </div>
              ))}
            </SettingsCard>

            <SettingsCard noPadding>
              <div className="px-5 pt-4 pb-1">
                <CardHeading icon={CreditCard} iconClass="bg-expense/12 text-expense" title="Credit Cards" />
              </div>
              {(creditCards as CreditCardProfile[]).map((c, i) => {
                const account = (accounts as Account[]).find((a) => a.id === c.accountId);
                return (
                  <div key={c.id}>
                    {i > 0 && <SettingsDivider />}
                    <SettingsRow
                      icon={<CreditCard className="size-4.5" />}
                      label={account?.name ?? "Credit Card"}
                      description={`${c.cardNetwork ?? "—"} •••• ${c.lastFourDigits ?? "----"}`}
                      control={<span className="font-mono text-sm font-semibold tabular-nums text-foreground">{formatCurrency(account?.currentBalance ?? 0)}</span>}
                    />
                  </div>
                );
              })}
            </SettingsCard>

            {authUser?.uid && (
              <PdfAnalyzerSetupCard uid={authUser.uid} creditCards={creditCards as CreditCardProfile[]} accounts={accounts as Account[]} />
            )}
          </div>
        )}

        {tab === "security" && (
          <div className="flex flex-col gap-4">
            <SettingsCard>
              <CardHeading icon={KeyRound} iconClass="bg-primary/12 text-primary-accent-text" title="Change password" />
              <p className="mt-3 text-sm text-muted-foreground">
                This account signs in with Google — there&apos;s no FlowFi password to change. Manage your Google
                account&apos;s password and security directly with Google.
              </p>
            </SettingsCard>

            <SettingsCard noPadding>
              <SettingsRow
                icon={<Lock className="size-4.5" />}
                label="Two-factor authentication"
                description="FlowFi signs in through Google, so 2-step verification is set up and enforced in your Google account, not here."
                control={
                  <Button asChild variant="outline" size="sm">
                    <a href="https://myaccount.google.com/signinoptions/two-step-verification" target="_blank" rel="noopener noreferrer">
                      Manage in Google
                    </a>
                  </Button>
                }
              />
            </SettingsCard>

            <SettingsCard noPadding className="border-destructive/30">
              <SettingsRow
                icon={<Trash2 className="size-4.5 text-destructive" />}
                label="Delete account"
                description="Not self-service yet — email us and we will delete your account and data."
                control={
                  <Button variant="destructive" size="sm" onClick={() => showUnavailable("Account deletion")}>
                    Delete account
                  </Button>
                }
              />
            </SettingsCard>
          </div>
        )}

        {tab === "notifications" && (
          <div className="flex flex-col gap-4">
            {pushPermission !== "granted" && <PermissionBanner onEnable={() => void enablePush()} />}
            <p className="text-xs text-muted-foreground">Your choices are saved on this device. Email, push and SMS delivery isn&apos;t live yet, so nothing is sent until it is.</p>

            <SettingsCard noPadding>
              <NotificationSettingsRow icon={Bell} label="Bill reminders" description="3 days before a bill is due" enabled={channels.bills} onChange={(k, v) => setChannel("bills", k, v)} />
              <SettingsDivider />
              <NotificationSettingsRow icon={SlidersHorizontal} label="Budget alerts" description="When a category nears its limit" enabled={channels.budgets} onChange={(k, v) => setChannel("budgets", k, v)} />
              <SettingsDivider />
              <NotificationSettingsRow icon={Shield} label="Security alerts" description="New sign-ins and password changes" enabled={channels.security} onChange={(k, v) => setChannel("security", k, v)} />
            </SettingsCard>

            <SettingsCard>
              <CardHeading icon={Megaphone} iconClass="bg-purple/15 text-purple" title="Weekly digest" />
              <div className="mt-3">
                <MultiSelect label="Include in weekly email" values={digestCategories} onChange={setDigestCategories} options={CATEGORY_OPTIONS} />
              </div>
            </SettingsCard>

            <SettingsCard noPadding>
              <SettingsRow
                label="Marketing emails"
                description="Product news and tips — unrelated to your account activity"
                control={<Switch checked={marketingEmails} onCheckedChange={setMarketingEmails} />}
              />
            </SettingsCard>
          </div>
        )}

        {tab === "backup" && (
          <div className="flex flex-col gap-4">
            <SettingsCard>
              <CardHeading icon={CloudUpload} iconClass="bg-primary/12 text-primary-accent-text" title="Backup & Restore" />
              <p className="mt-3 text-sm text-muted-foreground">
                Your data is already saved to the cloud automatically — every account, transaction, and budget
                syncs to FlowFi&apos;s servers in real time, so there&apos;s no separate backup step needed.
              </p>
              <p className="mt-3 text-sm text-muted-foreground">
                Backing up to Google Drive isn&apos;t available yet — it needs a Google Drive access request this
                app doesn&apos;t currently ask for.
              </p>
            </SettingsCard>

            <SettingsCard noPadding>
              <SettingsRow
                icon={<Download className="size-4.5" />}
                label="Export Data"
                description="Download your financial data as CSV"
                control={
                  <Button variant="outline" size="sm" onClick={() => toast.info("Export", "CSV export isn't wired up yet.")}>
                    Export
                  </Button>
                }
              />
            </SettingsCard>
          </div>
        )}

        {tab === "storage" && <StorageManagement />}

        {tab === "others" && (
          <div className="flex flex-col gap-4">
            <SettingsCard noPadding>
              <SettingsRow icon={<Keyboard className="size-4.5" />} label="Open command palette" control={<ClayBadge>⌘K</ClayBadge>} />
              <SettingsDivider />
              <SettingsRow icon={<Bell className="size-4.5" />} label="Toggle AI panel" control={<ClayBadge>⌘I</ClayBadge>} />
              <SettingsDivider />
              <SettingsRow icon={theme === "dark" ? <Moon className="size-4.5" /> : <Sun className="size-4.5" />} label="Toggle theme" control={<ClayBadge>⌘J</ClayBadge>} />
              <SettingsDivider />
              <SettingsRow icon={<Palette className="size-4.5" />} label="Go to Settings" control={<ClayBadge>G then S</ClayBadge>} />
            </SettingsCard>

            <SettingsCard noPadding>
              <SettingsRow icon={<BookOpen className="size-4.5" />} label="About FlowFi" description="FlowFi Web" />
              <SettingsDivider />
              <SettingsRow
                label="Terms & Privacy Policy"
                control={
                  <Link href="/privacy" aria-label="Open Terms & Privacy Policy" className="text-muted-foreground">
                    <ChevronRight className="size-4" />
                  </Link>
                }
              />
            </SettingsCard>
          </div>
        )}
      </div>

      <div className="flex flex-col gap-5 xl:sticky xl:top-0 xl:col-span-4 xl:self-start">
        <div className={SETTINGS_CARD}>
          <CardHeading icon={Landmark} iconClass="bg-primary/12 text-primary-accent-text" title="Account Summary" />
          <div className="mt-2 flex flex-col">
            <SummaryRow icon={Landmark} iconClass="bg-primary/12 text-primary-accent-text" label="Total Accounts" sublabel="Active" value={String(accounts.length)} href="/accounts" />
            <SummaryRow icon={Wallet} iconClass="bg-success/15 text-success" label="Total Balance" sublabel="Across all accounts" value={formatCurrency(totalBalance)} href="/accounts" />
            <SummaryRow icon={CreditCard} iconClass="bg-expense/12 text-expense" label="Credit Cards" sublabel="Active cards" value={String(creditCards.length)} href="/credit-cards" />
            <SummaryRow icon={HandCoins} iconClass="bg-warning/20 text-warning-foreground" label="Loans" sublabel="Active loans" value={String(loans.length)} href="/loans" />
            <SummaryRow icon={Users} iconClass="bg-purple/15 text-purple" label="People Ledger" sublabel="People added" value={String(people.length)} href="/people" />
          </div>
        </div>

        <div className={SETTINGS_CARD}>
          <CardHeading icon={Database} iconClass="bg-purple/15 text-purple" title="Data Management" />
          <div className="mt-2 flex flex-col">
            <ActionRow icon={Download} iconClass="bg-primary/12 text-primary-accent-text" label="Export Data" description="Download your financial data" onClick={() => toast.info("Export", "CSV export isn't wired up yet.")} />
            <ActionRow icon={Upload} iconClass="bg-purple/15 text-purple" label="Import Data" description="Import transactions from file" onClick={() => toast.info("Import", "Statement import lives in Transactions → Import Statement.")} />
            <ActionRow icon={Trash2} iconClass="bg-warning/20 text-warning-foreground" label="Clear Cache" description="Free up app storage space" onClick={() => toast.info("Clear cache", "Not applicable — data is synced live from Firestore, not cached locally.")} />
          </div>
        </div>

        <div className="rounded-[20px] border border-expense/30 bg-gradient-to-br from-expense/10 to-expense/[0.03] p-5">
          <CardHeading icon={AlertTriangle} iconClass="bg-expense/15 text-expense" title="Danger Zone" />
          <div className="mt-2 flex flex-col">
            <ActionRow icon={RotateCcw} iconClass="bg-expense/12 text-expense" label="Reset App" description="Reset app to default settings" destructive onClick={() => setResetOpen(true)} />
            <ActionRow icon={Database} iconClass="bg-expense/12 text-expense" label="Delete All Data" description="Not self-service yet — email us" destructive onClick={() => showUnavailable("Deleting all data")} />
            <ActionRow icon={AlertTriangle} iconClass="bg-expense/12 text-expense" label="Delete Account" description="Not self-service yet — email us" destructive onClick={() => showUnavailable("Account deletion")} />
          </div>
        </div>
      </div>

      <DeleteDialog
        open={resetOpen}
        onOpenChange={setResetOpen}
        title="Reset app to default settings?"
        description="Every preference on this page — including your Month cycle start day and profile photo — goes back to its default. Your accounts, transactions, loans and other financial data are not touched."
        onConfirm={() => {
          setResetOpen(false);
          reset();
          setPhone("");
          setActiveTheme("system");
          toast.success("Preferences reset", "Settings are back to their defaults.");
        }}
      />
      <ScrollNav />
    </div>
  );
}
