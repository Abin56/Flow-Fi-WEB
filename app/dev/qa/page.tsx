import { notFound } from "next/navigation";

/**
 * LOCAL MANUAL-QA ONLY. Outside a development server this route does not exist (404) AND the portal's code is
 * not part of the bundle: the import below sits inside a `NODE_ENV === "development"` branch, a build-time
 * constant, so production builds eliminate it (verified by searching the production output). Inside a dev
 * server, `QaPortal` additionally refuses to operate unless the emulator guard passes.
 */
export default async function QaPage() {
  if (process.env.NODE_ENV === "development") {
    const { QaPortal } = await import("@/features/dev-qa/components/qa-portal");
    return <QaPortal />;
  }
  notFound();
}
