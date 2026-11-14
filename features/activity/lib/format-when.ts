export function formatWhen(date: Date, now = new Date()): string {
  const day = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const diff = Math.round((day(now) - day(date)) / 86_400_000);
  const time = date.toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit" });
  const label = diff === 0 ? "Today" : diff === 1 ? "Yesterday" : date.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: date.getFullYear() === now.getFullYear() ? undefined : "numeric" });
  return `${label} · ${time}`;
}

export function formatDay(date: Date): string {
  return date.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
}
