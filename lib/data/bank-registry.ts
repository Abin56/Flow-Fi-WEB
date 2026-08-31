/**
 * Direct port of `core/data/bank_registry.dart`'s `BankRegistry` — single
 * source of truth for Indian bank reference data, used wherever a card or
 * account needs a bank identity (`Account.bankId`). Adding a bank later
 * means appending one `BankInfo` to `BANKS` and nothing else.
 */

export interface BankInfo {
  id: string;
  name: string;
  shortCode: string;
  color: string;
  /** Surfaced first in bank pickers — the handful of banks most users hold cards with. */
  frequent?: boolean;
}

/** Shown when a bank couldn't be identified — never returned by `bankById` for a real lookup. */
export const GENERIC_BANK: BankInfo = { id: "generic", name: "Other / Generic Bank", shortCode: "BANK", color: "#6B6C7A" };

export const BANKS: BankInfo[] = [
  { id: "sbi", name: "State Bank of India", shortCode: "SBI", color: "#2D6A4F", frequent: true },
  { id: "hdfc", name: "HDFC Bank", shortCode: "HDFC", color: "#C0392B", frequent: true },
  { id: "icici", name: "ICICI Bank", shortCode: "ICICI", color: "#E8720C", frequent: true },
  { id: "axis", name: "Axis Bank", shortCode: "AXIS", color: "#7B1F3A", frequent: true },
  { id: "kotak", name: "Kotak Mahindra Bank", shortCode: "KOTAK", color: "#C0272D", frequent: true },
  { id: "pnb", name: "Punjab National Bank", shortCode: "PNB", color: "#8E1B2E", frequent: true },
  { id: "bob", name: "Bank of Baroda", shortCode: "BOB", color: "#E8722C", frequent: true },
  { id: "canara", name: "Canara Bank", shortCode: "CNRB", color: "#FFA53E", frequent: true },
  { id: "union_bank", name: "Union Bank of India", shortCode: "UBI", color: "#1B5FA8" },
  { id: "indian_bank", name: "Indian Bank", shortCode: "IB", color: "#1FB873" },
  { id: "iob", name: "Indian Overseas Bank", shortCode: "IOB", color: "#2C5AA0" },
  { id: "federal", name: "Federal Bank", shortCode: "FED", color: "#0F7B3E" },
  { id: "south_indian", name: "South Indian Bank", shortCode: "SIB", color: "#14539A" },
  { id: "idfc_first", name: "IDFC FIRST Bank", shortCode: "IDFC", color: "#7B2CBF" },
  { id: "indusind", name: "IndusInd Bank", shortCode: "IIB", color: "#8B1E3F" },
  { id: "yes_bank", name: "Yes Bank", shortCode: "YES", color: "#1F1F1F" },
  { id: "au_sfb", name: "AU Small Finance Bank", shortCode: "AU", color: "#E8720C" },
  { id: "uco", name: "UCO Bank", shortCode: "UCO", color: "#1B5FA8" },
  { id: "central_bank", name: "Central Bank of India", shortCode: "CBI", color: "#1B4F72" },
  { id: "punjab_sind", name: "Punjab & Sind Bank", shortCode: "PSB", color: "#7B241C" },
  { id: "karnataka", name: "Karnataka Bank", shortCode: "KBL", color: "#117A65" },
  { id: "karur_vysya", name: "Karur Vysya Bank", shortCode: "KVB", color: "#922B21" },
  { id: "dcb", name: "DCB Bank", shortCode: "DCB", color: "#B9770E" },
  { id: "rbl", name: "RBL Bank", shortCode: "RBL", color: "#616A6B" },
  { id: "bandhan", name: "Bandhan Bank", shortCode: "BDN", color: "#AF601A" },
  { id: "city_union", name: "City Union Bank", shortCode: "CUB", color: "#1F618D" },
  { id: "standard_chartered", name: "Standard Chartered", shortCode: "SC", color: "#005EB8" },
  { id: "hsbc", name: "HSBC India", shortCode: "HSBC", color: "#DB0011" },
  { id: "dbs", name: "DBS Bank India", shortCode: "DBS", color: "#EC1C24" },
  { id: "citi", name: "Citi (legacy)", shortCode: "CITI", color: "#003A79" },
  { id: "boi", name: "Bank of India", shortCode: "BOI", color: "#B8860B" },
  { id: "bom", name: "Bank of Maharashtra", shortCode: "BOM", color: "#1A5276" },
  { id: "j_and_k", name: "Jammu & Kashmir Bank", shortCode: "J&K", color: "#7D3C98" },
  { id: "tmb", name: "Tamilnad Mercantile Bank", shortCode: "TMB", color: "#196F3D" },
  { id: "nainital", name: "Nainital Bank", shortCode: "NTB", color: "#1B4F72" },
  { id: "dhanlaxmi", name: "Dhanlaxmi Bank", shortCode: "DLB", color: "#922B21" },
  { id: "csb", name: "CSB Bank", shortCode: "CSB", color: "#117864" },
  { id: "equitas_sfb", name: "Equitas Small Finance Bank", shortCode: "EQSFB", color: "#B03A2E" },
  { id: "ujjivan_sfb", name: "Ujjivan Small Finance Bank", shortCode: "UJSFB", color: "#D35400" },
  { id: "jana_sfb", name: "Jana Small Finance Bank", shortCode: "JSFB", color: "#1F618D" },
  { id: "suryoday_sfb", name: "Suryoday Small Finance Bank", shortCode: "SSFB", color: "#CA6F1E" },
  { id: "esaf_sfb", name: "ESAF Small Finance Bank", shortCode: "ESFB", color: "#1E8449" },
  { id: "north_east_sfb", name: "North East Small Finance Bank", shortCode: "NESFB", color: "#117A65" },
  { id: "utkarsh_sfb", name: "Utkarsh Small Finance Bank", shortCode: "USFB", color: "#B9770E" },
  { id: "paytm_pb", name: "Paytm Payments Bank", shortCode: "PPBL", color: "#00259A" },
  { id: "airtel_pb", name: "Airtel Payments Bank", shortCode: "APB", color: "#E40000" },
  { id: "india_post_pb", name: "India Post Payments Bank", shortCode: "IPPB", color: "#8B1E3F" },
  { id: "fino_pb", name: "Fino Payments Bank", shortCode: "FPB", color: "#7B241C" },
  { id: "nsdl_pb", name: "NSDL Payments Bank", shortCode: "NSDL", color: "#1B4F72" },
  { id: "deutsche", name: "Deutsche Bank", shortCode: "DB", color: "#0018A8" },
  { id: "barclays", name: "Barclays India", shortCode: "BARC", color: "#00AEEF" },
  { id: "bofa", name: "Bank of America India", shortCode: "BOA", color: "#E31837" },
  { id: "jpmorgan", name: "JPMorgan Chase India", shortCode: "JPM", color: "#003087" },
  { id: "mizuho", name: "Mizuho Bank India", shortCode: "MIZ", color: "#00529B" },
  { id: "sbm", name: "SBM Bank India", shortCode: "SBM", color: "#1F618D" },
  { id: "idbi", name: "IDBI Bank", shortCode: "IDBI", color: "#7B241C" },
];

export function bankById(id: string | null | undefined): BankInfo | null {
  if (!id) return null;
  return BANKS.find((b) => b.id === id) ?? null;
}

export const FREQUENT_BANKS: BankInfo[] = BANKS.filter((b) => b.frequent);
