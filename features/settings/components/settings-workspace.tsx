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
import { useState } from "react";
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
import { NotificationSettingsRow } from "@/components/notifications/notification-settings-row";
import { PermissionBanner } from "@/components/notifications/permission-banner";
import { SettingsCard } from "@/components/settings/settings-card";
import { SettingsDivider } from "@/components/settings/settings-divider";
import { SettingsRow } from "@/components/settings/settings-row";
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
import { useUserPreferences } from "@/features/settings/hooks/use-user-preferences";
import { PdfAnalyzerSetupCard } from "@/features/settings/components/pdf-analyzer-setup-card";

type SettingsTab = "profile" | "preferences" | "accounts" | "security" | "notifications" | "backup" | "others";

const TABS: { id: SettingsTab; label: string; icon: LucideIcon }[] = [
  { id: "profile", label: "Profile", icon: User },
  { id: "preferences", label: "Preferences", icon: SlidersHorizontal },
  { id: "accounts", label: "Accounts", icon: Wallet },
  { id: "security", label: "Security", icon: Shield },
  { id: "notifications", label: "Notifications", icon: Bell },
  { id: "backup", label: "Backup & Restore", icon: CloudUpload },
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

function SummaryRow({ icon: Icon, iconClass, label, value, sublabel }: { icon: LucideIcon; iconClass: string; label: string; value: string; sublabel: string }) {
  return (
    <button type="button" className="flex w-full items-center gap-3 rounded-xl px-1 py-2.5 text-left transition-colors hover:bg-muted/50">
      <span className={cn("flex size-9 shrink-0 items-center justify-center rounded-xl", iconClass)}>
        <Icon className="size-4" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-foreground">{label}</p>
        <p className="text-xs text-muted-foreground">{sublabel}</p>
      </div>
      <span className="shrink-0 font-mono text-sm font-semibold tabular-nums text-foreground">{value}</span>
      <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
    </button>
  );
}

/** Colored icon badge + title/description — the section heading used atop every settings card, so each
 *  card reads at a glance instead of blending into a wall of plain text headers. */
function CardHeading({ icon: Icon, iconClass, title, description }: { icon: LucideIcon; iconClass: string; title: string; description?: string }) {
  return (
    <div className="flex items-start gap-3">
      <span className={cn("flex size-9 shrink-0 items-center justify-center rounded-xl", iconClass)}>
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
      <span className={cn("flex size-9 shrink-0 items-center justify-center rounded-xl", iconClass)}>
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
  const { preferences, update } = useUserPreferences();

  // Profile — seeded from the real signed-in Google account (this app is
  // Google Sign-In only, see `services/auth/auth-service.ts`; there is no
  // separate phone/timezone field on the Firebase Auth user, so phone stays
  // a local preference rather than fabricated account data. `fullName` stays
  // local edit-buffer state until "Save Changes" persists it via `updateProfile`.
  const [fullName, setFullName] = useState(authUser?.displayName ?? "");
  const [email] = useState(authUser?.email ?? "");
  const phone = preferences.phone;
  const setPhone = (v: string) => update("phone", v);
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

  // Security (Profile tab quick card)
  const biometricLock = preferences.biometricLock;
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
  const theme = preferences.theme;
  const setTheme = (v: string) => update("theme", v);
  const accentColor = preferences.accentColor;
  const setAccentColor = (v: string) => update("accentColor", v);
  const density = preferences.density;
  const setDensity = (v: number) => update("density", v);

  // Security tab (deeper)
  const twoFactor = preferences.twoFactor;
  const setTwoFactor = (v: boolean) => update("twoFactor", v);
  const [deleteAccountOpen, setDeleteAccountOpen] = useState(false);

  // Notifications tab (deeper)
  const [pushGranted, setPushGranted] = useState(false);
  const digestCategories = preferences.digestCategories;
  const setDigestCategories = (v: string[]) => update("digestCategories", v);
  const channels = preferences.channels;
  const marketingEmails = preferences.marketingEmails;
  const setMarketingEmails = (v: boolean) => update("marketingEmails", v);

  // Danger zone
  const [resetOpen, setResetOpen] = useState(false);
  const [deleteAllOpen, setDeleteAllOpen] = useState(false);

  function setChannel(row: string, key: string, value: boolean) {
    update("channels", { ...channels, [row]: { ...channels[row], [key]: value } });
  }

  const totalBalance = (accounts as Account[]).reduce((sum, a) => sum + a.currentBalance, 0);

  async function handleSaveProfile() {
    if (!authUser) return;
    try {
      await updateProfile(authUser, { displayName: fullName });
      toast.success("Settings saved", "Your changes have been applied.");
    } catch {
      toast.error("Couldn't save profile", "Please try again.");
    }
  }

  return (
    <div className="grid grid-cols-1 gap-5 px-1 xl:grid-cols-12">
      <div className="flex flex-col gap-5 xl:col-span-8">
        <div>
          <h1 className="font-heading text-2xl font-bold tracking-tight text-foreground">Settings</h1>
          <p className="mt-1 text-sm text-muted-foreground">Manage your preferences and app configurations</p>
        </div>

        <div className="flex flex-wrap items-center gap-1 overflow-x-auto border-b border-border/60">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => setTab(t.id)}
              className={cn(
                "flex shrink-0 items-center gap-1.5 border-b-2 px-3 py-2.5 text-sm font-medium transition-colors",
                tab === t.id ? "border-primary text-primary" : "border-transparent text-muted-foreground hover:text-foreground",
              )}
            >
              <t.icon className="size-4" />
              {t.label}
            </button>
          ))}
        </div>

        {tab === "profile" && (
          <div className="flex flex-col gap-5">
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
              <div className="surface-flat rounded-3xl border border-border/50 p-5">
                <CardHeading icon={User} iconClass="bg-primary/12 text-primary" title="Profile Information" description="Update your personal information and profile details." />

                <div className="mt-4 flex items-center gap-4">
                  <div className="relative">
                    <ClayAvatar name={fullName} size={72} />
                    <button
                      type="button"
                      aria-label="Change photo"
                      onClick={() => toast.info("Avatar picker", "Mock only — no upload wired up.")}
                      className="absolute -right-1 -bottom-1 flex size-6 items-center justify-center rounded-full border-2 border-card bg-primary text-primary-foreground"
                    >
                      <Camera className="size-3" />
                    </button>
                  </div>
                </div>

                <div className="mt-4 flex flex-col gap-3">
                  <TextField label="Full Name" value={fullName} onChange={(e) => setFullName(e.target.value)} />
                  <TextField label="Email Address" type="email" value={email} disabled onChange={() => {}} />
                  <TextField label="Phone Number" value={phone} onChange={(e) => setPhone(e.target.value)} />
                  <div className="flex flex-col gap-1.5">
                    <span className="text-sm font-medium text-foreground">Timezone</span>
                    <RowSelect
                      value={timezone}
                      onChange={setTimezone}
                      className="w-full"
                      options={[
                        { value: "ist", label: "(GMT+05:30) India Standard Time" },
                        { value: "utc", label: "(GMT+00:00) UTC" },
                        { value: "pst", label: "(GMT-08:00) Pacific Time" },
                      ]}
                    />
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <span className="text-sm font-medium text-foreground">Currency</span>
                    <RowSelect
                      value={currency}
                      onChange={setCurrency}
                      className="w-full"
                      options={[
                        { value: "inr", label: "INR - Indian Rupee (₹)" },
                        { value: "usd", label: "USD - US Dollar ($)" },
                        { value: "eur", label: "EUR - Euro (€)" },
                      ]}
                    />
                  </div>
                </div>

                <div className="mt-4 flex justify-end">
                  <ClayButton onClick={handleSaveProfile}>Save Changes</ClayButton>
                </div>
              </div>

              <div className="surface-flat rounded-3xl border border-border/50 p-5">
                <CardHeading icon={SlidersHorizontal} iconClass="bg-purple/15 text-purple" title="App Preferences" description="Customize the app to match your workflow." />

                <div className="mt-2 flex flex-col divide-y divide-border/60">
                  <SettingsRow
                    icon={<Home className="size-4.5" />}
                    label="Default Home View"
                    description="Choose your default landing page"
                    control={
                      <RowSelect
                        value={defaultHomeView}
                        onChange={setDefaultHomeView}
                        options={[
                          { value: "dashboard", label: "Dashboard" },
                          { value: "transactions", label: "Transactions" },
                          { value: "budgets", label: "Budgets" },
                        ]}
                      />
                    }
                  />
                  <SettingsRow
                    icon={<Wallet className="size-4.5" />}
                    label="Default Account"
                    description="Select account for new transactions"
                    control={
                      <RowSelect
                        value={defaultAccount}
                        onChange={setDefaultAccount}
                        options={[{ value: "select", label: "Select Account" }, ...(accounts as Account[]).map((a) => ({ value: a.id, label: a.name }))]}
                      />
                    }
                  />
                  <SettingsRow
                    icon={<Calendar className="size-4.5" />}
                    label="Date Format"
                    description="Choose your preferred date format"
                    control={
                      <RowSelect
                        value={dateFormat}
                        onChange={setDateFormat}
                        options={[
                          { value: "dd-mmm-yyyy", label: "DD MMM YYYY" },
                          { value: "mm-dd-yyyy", label: "MM/DD/YYYY" },
                          { value: "yyyy-mm-dd", label: "YYYY-MM-DD" },
                        ]}
                      />
                    }
                  />
                  <SettingsRow
                    icon={<Hash className="size-4.5" />}
                    label="Number Format"
                    description="Choose number and currency format"
                    control={
                      <RowSelect
                        value={numberFormat}
                        onChange={setNumberFormat}
                        options={[
                          { value: "indian", label: "1,23,456.78" },
                          { value: "international", label: "123,456.78" },
                        ]}
                      />
                    }
                  />
                  <SettingsRow
                    icon={<Globe className="size-4.5" />}
                    label="Language"
                    description="Select your preferred language"
                    control={
                      <RowSelect
                        value={language}
                        onChange={setLanguage}
                        options={[
                          { value: "en", label: "English" },
                          { value: "hi", label: "Hindi" },
                        ]}
                      />
                    }
                  />
                  <SettingsRow
                    icon={<CalendarRange className="size-4.5" />}
                    label="Start Week On"
                    description="Choose the first day of the week"
                    control={
                      <RowSelect
                        value={startWeekOn}
                        onChange={setStartWeekOn}
                        options={[
                          { value: "monday", label: "Monday" },
                          { value: "sunday", label: "Sunday" },
                        ]}
                      />
                    }
                  />
                </div>
              </div>
            </div>

            <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
              <div className="surface-flat rounded-3xl border border-border/50 p-5">
                <CardHeading icon={Shield} iconClass="bg-warning/20 text-warning-foreground" title="Security Settings" description="Manage your security and privacy preferences." />
                <div className="mt-2 flex flex-col divide-y divide-border/60">
                  <SettingsRow
                    icon={<KeyRound className="size-4.5" />}
                    label="Change Password"
                    description="Update your account password"
                    control={
                      <button type="button" onClick={() => setTab("security")} className="text-muted-foreground">
                        <ChevronRight className="size-4" />
                      </button>
                    }
                  />
                  <SettingsRow
                    icon={<Fingerprint className="size-4.5" />}
                    label="Biometric Lock"
                    description="Use fingerprint/face to unlock app"
                    control={<Switch checked={biometricLock} onCheckedChange={setBiometricLock} />}
                  />
                  <SettingsRow
                    icon={<Timer className="size-4.5" />}
                    label="Auto Lock"
                    description="Automatically lock the app"
                    control={
                      <RowSelect
                        value={autoLockMinutes}
                        onChange={setAutoLockMinutes}
                        options={[
                          { value: "1", label: "1 minute" },
                          { value: "5", label: "5 minutes" },
                          { value: "15", label: "15 minutes" },
                        ]}
                      />
                    }
                  />
                  <SettingsRow
                    icon={<EyeOff className="size-4.5" />}
                    label="Privacy Mode"
                    description="Hide sensitive data in previews"
                    control={<Switch checked={privacyMode} onCheckedChange={setPrivacyMode} />}
                  />
                </div>
              </div>

              <div className="surface-flat rounded-3xl border border-border/50 p-5">
                <CardHeading icon={Bell} iconClass="bg-success/15 text-success" title="Notifications" description="Choose what notifications you want to receive." />
                <div className="mt-2 flex flex-col divide-y divide-border/60">
                  <SettingsRow icon={<Bell className="size-4.5" />} label="Transaction Alerts" description="Get notified for new transactions" control={<Switch checked={transactionAlerts} onCheckedChange={setTransactionAlerts} />} />
                  <SettingsRow icon={<Receipt className="size-4.5" />} label="Bill Reminders" description="Reminders for upcoming bills" control={<Switch checked={billReminders} onCheckedChange={setBillReminders} />} />
                  <SettingsRow icon={<CalendarClock className="size-4.5" />} label="EMI Reminders" description="Reminders for upcoming EMIs" control={<Switch checked={emiReminders} onCheckedChange={setEmiReminders} />} />
                  <SettingsRow icon={<Wallet className="size-4.5" />} label="Budget Alerts" description="Alerts for budget limits" control={<Switch checked={budgetAlerts} onCheckedChange={setBudgetAlerts} />} />
                  <SettingsRow icon={<Megaphone className="size-4.5" />} label="Marketing Updates" description="Updates about new features" control={<Switch checked={marketingUpdates} onCheckedChange={setMarketingUpdates} />} />
                </div>
              </div>

              <div className="surface-flat rounded-3xl border border-border/50 p-5">
                <CardHeading icon={CloudUpload} iconClass="bg-primary/12 text-primary" title="Backup & Restore" />
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
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <span className="flex size-8 items-center justify-center rounded-full bg-success/15 text-success">
                  <ShieldCheck className="size-4" />
                </span>
                <div>
                  <p className="font-medium text-foreground">All systems secure</p>
                  <p>Last checked: Today, 10:30 AM</p>
                </div>
              </div>
            </div>
          </div>
        )}

        {tab === "preferences" && (
          <div className="flex flex-col gap-4">
            <SettingsCard>
              <CardHeading icon={Wallet} iconClass="bg-primary/12 text-primary" title="Budgeting" />
              <div className="mt-3">
                <CurrencyField label="Default monthly budget" value={monthlyBudget} onChange={setMonthlyBudget} description="Used as the starting point for new budget cycles." />
              </div>
            </SettingsCard>

            <SettingsCard noPadding>
              <SettingsRow
                icon={<SlidersHorizontal className="size-4.5" />}
                label="Early access features"
                description="Try new FlowFi features before general release"
                control={<Switch checked={betaFeatures} onCheckedChange={setBetaFeatures} />}
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
                <ColorPicker value={accentColor} onChange={setAccentColor} />
              </div>
            </SettingsCard>

            <SettingsCard>
              <CardHeading icon={SlidersHorizontal} iconClass="bg-success/15 text-success" title="Density" />
              <div className="mt-3">
                <SliderField label="Interface density" value={density} onChange={setDensity} formatValue={(v) => (v < 33 ? "Compact" : v < 66 ? "Comfortable" : "Spacious")} />
              </div>
            </SettingsCard>
          </div>
        )}

        {tab === "accounts" && (
          <div className="flex flex-col gap-4">
            <SettingsCard noPadding>
              <div className="px-5 pt-4 pb-1">
                <CardHeading icon={Landmark} iconClass="bg-primary/12 text-primary" title="Bank & Cash Accounts" />
              </div>
              {(accounts as Account[]).map((a, i) => (
                <div key={a.id}>
                  {i > 0 && <SettingsDivider />}
                  <SettingsRow
                    icon={<Landmark className="size-4.5" />}
                    label={a.name}
                    description={a.bankId ?? "No institution"}
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
              <CardHeading icon={KeyRound} iconClass="bg-primary/12 text-primary" title="Change password" />
              <p className="mt-3 text-sm text-muted-foreground">
                This account signs in with Google — there&apos;s no FlowFi password to change. Manage your Google
                account&apos;s password and security directly with Google.
              </p>
            </SettingsCard>

            <SettingsCard noPadding>
              <SettingsRow
                icon={<Lock className="size-4.5" />}
                label="Two-factor authentication"
                description="Require a code from your authenticator app at sign-in"
                control={<Switch checked={twoFactor} onCheckedChange={setTwoFactor} />}
              />
            </SettingsCard>

            <SettingsCard noPadding className="border-destructive/30">
              <SettingsRow
                icon={<Trash2 className="size-4.5 text-destructive" />}
                label="Delete account"
                description="Permanently remove your account and all associated data."
                control={
                  <Button variant="destructive" size="sm" onClick={() => setDeleteAccountOpen(true)}>
                    Delete account
                  </Button>
                }
              />
            </SettingsCard>
          </div>
        )}

        {tab === "notifications" && (
          <div className="flex flex-col gap-4">
            {!pushGranted && (
              <PermissionBanner
                onEnable={() => {
                  setPushGranted(true);
                  toast.success("Push notifications enabled");
                }}
              />
            )}

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
              <CardHeading icon={CloudUpload} iconClass="bg-primary/12 text-primary" title="Backup & Restore" />
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
              <SettingsRow icon={<BookOpen className="size-4.5" />} label="About FlowFi" description="Version 1.0.0" />
              <SettingsDivider />
              <SettingsRow
                label="Terms & Privacy Policy"
                control={
                  <button type="button" className="text-muted-foreground">
                    <ChevronRight className="size-4" />
                  </button>
                }
              />
            </SettingsCard>
          </div>
        )}
      </div>

      <div className="flex flex-col gap-5 xl:col-span-4">
        <div className="surface-flat rounded-3xl border border-border/50 p-5">
          <CardHeading icon={Landmark} iconClass="bg-primary/12 text-primary" title="Account Summary" />
          <div className="mt-2 flex flex-col">
            <SummaryRow icon={Landmark} iconClass="bg-primary/12 text-primary" label="Total Accounts" sublabel="Active" value={String(accounts.length)} />
            <SummaryRow icon={Wallet} iconClass="bg-success/15 text-success" label="Total Balance" sublabel="Across all accounts" value={formatCurrency(totalBalance)} />
            <SummaryRow icon={CreditCard} iconClass="bg-expense/12 text-expense" label="Credit Cards" sublabel="Active cards" value={String(creditCards.length)} />
            <SummaryRow icon={HandCoins} iconClass="bg-warning/20 text-warning-foreground" label="Loans" sublabel="Active loans" value={String(loans.length)} />
            <SummaryRow icon={Users} iconClass="bg-purple/15 text-purple" label="People Ledger" sublabel="People added" value={String(people.length)} />
          </div>
        </div>

        <div className="surface-flat rounded-3xl border border-border/50 p-5">
          <CardHeading icon={Database} iconClass="bg-purple/15 text-purple" title="Data Management" />
          <div className="mt-2 flex flex-col">
            <ActionRow icon={Download} iconClass="bg-primary/12 text-primary" label="Export Data" description="Download your financial data" onClick={() => toast.info("Export", "CSV export isn't wired up yet.")} />
            <ActionRow icon={Upload} iconClass="bg-purple/15 text-purple" label="Import Data" description="Import transactions from file" onClick={() => toast.info("Import", "Statement import lives in Transactions → Import Statement.")} />
            <ActionRow icon={Trash2} iconClass="bg-warning/20 text-warning-foreground" label="Clear Cache" description="Free up app storage space" onClick={() => toast.info("Clear cache", "Not applicable — data is synced live from Firestore, not cached locally.")} />
          </div>
        </div>

        <div className="rounded-3xl border border-expense/30 bg-expense/5 p-5">
          <CardHeading icon={AlertTriangle} iconClass="bg-expense/15 text-expense" title="Danger Zone" />
          <div className="mt-2 flex flex-col">
            <ActionRow icon={RotateCcw} iconClass="bg-expense/12 text-expense" label="Reset App" description="Reset app to default settings" destructive onClick={() => setResetOpen(true)} />
            <ActionRow icon={Database} iconClass="bg-expense/12 text-expense" label="Delete All Data" description="Permanently delete all your data" destructive onClick={() => setDeleteAllOpen(true)} />
            <ActionRow icon={AlertTriangle} iconClass="bg-expense/12 text-expense" label="Delete Account" description="Permanently delete your account" destructive onClick={() => setDeleteAccountOpen(true)} />
          </div>
        </div>
      </div>

      <DeleteDialog
        open={deleteAccountOpen}
        onOpenChange={setDeleteAccountOpen}
        title="Delete your account"
        description="This will permanently delete your FlowFi account, including all transactions, budgets, and connected accounts. This cannot be undone."
        itemName={fullName}
        onConfirm={() => {
          setDeleteAccountOpen(false);
          toast.error("Account deletion is disabled in this preview.");
        }}
      />

      <DeleteDialog
        open={resetOpen}
        onOpenChange={setResetOpen}
        title="Reset app to default settings?"
        description="Every preference on this page will be reset. Your financial data will not be affected."
        onConfirm={() => {
          setResetOpen(false);
          toast.error("Reset is disabled in this preview.");
        }}
      />

      <DeleteDialog
        open={deleteAllOpen}
        onOpenChange={setDeleteAllOpen}
        title="Delete all data?"
        description="This permanently deletes every transaction, account, budget, and loan in your FlowFi workspace."
        itemName="DELETE"
        onConfirm={() => {
          setDeleteAllOpen(false);
          toast.error("Data deletion is disabled in this preview.");
        }}
      />
    </div>
  );
}
