/**
 * FlowFi's one support and privacy contact, used by /privacy and the Help page. `NEXT_PUBLIC_PRIVACY_CONTACT_EMAIL`
 * overrides it at build time; the default keeps a static Hosting build correct on a machine without `.env.local`.
 */
export const OFFICIAL_CONTACT_EMAIL = "abinjohn.dev@gmail.com";

export const CONTACT_EMAIL = process.env.NEXT_PUBLIC_PRIVACY_CONTACT_EMAIL?.trim() || OFFICIAL_CONTACT_EMAIL;

export const CONTACT_MAILTO = `mailto:${CONTACT_EMAIL}`;
