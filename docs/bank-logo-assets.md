# Bank logo assets

`BankLogo` (web: `components/finance/bank-logo.tsx`, mobile: `lib/shared/widgets/bank_logo.dart`
in `Finance_App`) renders a bank's real logo when a matching image file exists, and a
brand-colored initials badge when it doesn't. **Web ships 41 PNG logos** in `public/banks/logos/`
(added 2026-10-09; mobile still has none). Real bank logos are trademarked artwork — they're used
here only to identify the user's own banks, and a bank's own brand kit should replace any file
before public distribution. Drop a file in place and both apps pick it up with no code change.

Shipped (web): airtel_pb, au_sfb, axis, bandhan, barclays, bob, bofa, bom, canara, citi, city_union,
csb, dcb, deutsche, equitas_sfb, esaf_sfb, federal, hdfc, hsbc, icici, idfc_first, indian_bank,
indusind, iob, jpmorgan, karnataka, karur_vysya, mizuho, north_east_sfb (now branded "slice"),
paytm_pb, pnb, punjab_sind, rbl, sbi, sbm, south_indian, standard_chartered, tmb, uco, union_bank,
yes_bank.

Still initials-only (no usable logo found): kotak, central_bank, dbs, boi, j_and_k, nainital,
dhanlaxmi, jana_sfb, suryoday_sfb, ujjivan_sfb, utkarsh_sfb, india_post_pb, fino_pb, nsdl_pb, idbi.

## Where files go

| Platform | Directory | Declared in |
|---|---|---|
| Web (`flowfi-web`) | `public/banks/logos/` | served directly by Next.js, no config needed |
| Mobile (`Finance_App`) | `assets/banks/logos/` | `pubspec.yaml` → `flutter: assets:` (already added) |

## File naming

One file per bank id, lowercase, matching the id in `lib/data/bank-registry.ts` (web) /
`lib/core/data/bank_registry.dart` (mobile) — **the two registries are kept in sync and use
identical ids**. SVG is preferred (crisp at any size, smaller file); PNG is the fallback if a bank
only publishes a raster mark.

```
public/banks/logos/hdfc.svg        (web)
assets/banks/logos/hdfc.svg        (mobile)
```

Lookup order per bank: `{id}.svg` → `{id}.png` → initials badge. You don't need both formats —
just one is enough to switch that bank over.

## Format specs

- **SVG**: single logo mark (not a lockup with tagline/address), transparent background, no
  embedded `<script>`. Trim to the mark's own bounding box — `BankLogo` handles padding/sizing.
- **PNG** (only if no SVG source exists): transparent background, at least 256×256px so it stays
  sharp at the largest size it's shown (a 96×96 hero card face) without upscaling artifacts.
- Both apps render the file inside a white rounded badge with ~14% internal padding, so a logo
  designed for a colored background (all-white mark, etc.) may not read well — prefer each bank's
  full-color or single-dark-color mark on transparency.

## Full bank list (52 banks + the "Other / Generic Bank" catch-all)

`generic` intentionally has **no** logo slot — it's the user-facing "my bank isn't listed" choice
and always renders as a neutral bank icon, never an initials badge or a real logo.

| id | Bank | id | Bank |
|---|---|---|---|
| `sbi` | State Bank of India | `dhanlaxmi` | Dhanlaxmi Bank |
| `hdfc` | HDFC Bank | `csb` | CSB Bank |
| `icici` | ICICI Bank | `equitas_sfb` | Equitas Small Finance Bank |
| `axis` | Axis Bank | `ujjivan_sfb` | Ujjivan Small Finance Bank |
| `kotak` | Kotak Mahindra Bank | `jana_sfb` | Jana Small Finance Bank |
| `pnb` | Punjab National Bank | `suryoday_sfb` | Suryoday Small Finance Bank |
| `bob` | Bank of Baroda | `esaf_sfb` | ESAF Small Finance Bank |
| `canara` | Canara Bank | `north_east_sfb` | North East Small Finance Bank |
| `union_bank` | Union Bank of India | `utkarsh_sfb` | Utkarsh Small Finance Bank |
| `indian_bank` | Indian Bank | `paytm_pb` | Paytm Payments Bank |
| `iob` | Indian Overseas Bank | `airtel_pb` | Airtel Payments Bank |
| `federal` | Federal Bank | `india_post_pb` | India Post Payments Bank |
| `south_indian` | South Indian Bank | `fino_pb` | Fino Payments Bank |
| `idfc_first` | IDFC FIRST Bank | `nsdl_pb` | NSDL Payments Bank |
| `indusind` | IndusInd Bank | `deutsche` | Deutsche Bank |
| `yes_bank` | Yes Bank | `barclays` | Barclays India |
| `au_sfb` | AU Small Finance Bank | `bofa` | Bank of America India |
| `uco` | UCO Bank | `jpmorgan` | JPMorgan Chase India |
| `central_bank` | Central Bank of India | `mizuho` | Mizuho Bank India |
| `punjab_sind` | Punjab & Sind Bank | `sbm` | SBM Bank India |
| `karnataka` | Karnataka Bank | `idbi` | IDBI Bank |
| `karur_vysya` | Karur Vysya Bank | `citi` | Citi (legacy) |
| `dcb` | DCB Bank | `boi` | Bank of India |
| `rbl` | RBL Bank | `bom` | Bank of Maharashtra |
| `bandhan` | Bandhan Bank | `j_and_k` | Jammu & Kashmir Bank |
| `city_union` | City Union Bank | `tmb` | Tamilnad Mercantile Bank |
| `standard_chartered` | Standard Chartered | `nainital` | Nainital Bank |
| `hsbc` | HSBC India | | |
| `dbs` | DBS Bank India | | |

**Priority order** if you're not sourcing all 52 at once — this covers the large majority of real
accounts users will add first: `sbi`, `hdfc`, `icici`, `axis`, `kotak`, `pnb`, `bob`, `canara`
(these 8 are the ones already flagged `frequent: true` / `isFrequent: true` and surfaced first in
both bank pickers).

## Sourcing

Get logo files from each bank's own official brand/press kit or a source you have the rights to
redistribute in an app — this is trademarked material, so don't scrape arbitrary logo sites.
The codebase never fetches logos at runtime.

How the shipped web set was made (one-off, by hand): each bank's official logo as recorded on
Wikidata (P154) / Wikimedia Commons, or — for city_union and north_east_sfb — the icon on the bank's
own website; then trimmed to the bank's emblem where it has one (whole logo for wordmarks) and saved
as a square 256×256 transparent PNG with ~8% padding, so it reads inside the small round badge.

## Verifying a drop-in

After adding a file, no rebuild step is needed on web (static `/public` asset, picked up on next
page load). On mobile, run `flutter pub get` once after adding files to a previously-empty
`assets/banks/logos/` directory (Flutter re-scans the declared directory), then hot restart.
