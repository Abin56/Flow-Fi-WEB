import { notFound } from "next/navigation";

/** LOCAL DESIGN/QA ONLY — 404s outside a development server; the showcase import is eliminated from production builds. */
export default async function PanelsPage() {
  if (process.env.NODE_ENV === "development") {
    const { PanelShowcase } = await import("@/features/dev-qa/components/panel-showcase");
    return <PanelShowcase />;
  }
  notFound();
}
