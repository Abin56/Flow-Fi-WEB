# Balance Control — figure definitions (P0, read-only)

Balance Control compares a figure you type from a bank or lender with **FlowFi's own figure**. Every definition
below is *FlowFi's* definition. It is not a claim about how any particular bank, card network or lender calculates
the same label — banks differ, and a difference is not automatically an error. Balance Control never changes a
balance, transaction, schedule or limit; typed figures are held in the page only and are not saved.

All FlowFi figures are read from the engines the rest of the app already uses (card standings, loan rows, EMI
schedules). Balance Control re-implements none of them.

## Total outstanding (cards)
FlowFi: billed amounts still unpaid on closed statements, **plus** unbilled spend in the open cycle, **plus** the
remaining principal of any EMI linked to the card (see *Locked EMI principal*), after card payments are applied
oldest-first. Never below zero. For a shared-limit facility the figure is **pooled** across every card under it.
- Not the statement balance.
- A bank may leave out EMI principal, or fold in interest, late fees or GST FlowFi has not recorded. Such a gap is
  labelled (for example "Card-EMI lock", "Bank higher") rather than called wrong.

## Statement balance (cards)
FlowFi: the total of the **latest closed statement** for this card only (the cycle that ended before today),
recomputed from the card's current transactions. It is a snapshot of one cycle: later payments and later spending
change *total outstanding*, not this figure. "No closed statement yet" is shown when no cycle has closed.
- A bank's statement balance can differ if the bank's cycle dates, posting dates or included fees differ.

## Available credit (cards)
FlowFi: limit − total outstanding (locked EMI principal is already inside total outstanding). For a shared facility
the limit and the available credit are the pooled facility values, identical on every sibling card.
- Banks may reserve amounts (holds, pending authorisations) or treat EMI principal differently.

## Locked EMI principal
FlowFi: the remaining principal (principal − principal repaid, interest excluded) of a not-closed EMI that is linked
to the card and **not** already represented by a recorded purchase on that card. It is counted once, in total
outstanding and in available credit. Whether a bank locks the full EMI amount against the limit is bank-specific;
Balance Control shows a difference equal to this amount as "Card-EMI lock" (explained), not as an error.

## Remaining principal (loans and EMIs)
FlowFi: principal left to repay from the stored schedule (after any extra principal paid). No interest, no charges.

## Lender payoff floor
FlowFi: the remaining principal, used only as a **floor**. A lender's real payoff amount can include accrued
interest, prepayment or foreclosure charges and taxes that FlowFi does not track. A lender figure above the floor
is shown as "Interest & charges"; a lender figure **below** the principal floor ("Below principal") is the only
payoff result that is flagged for review.

## Result labels
Matches · Rounding (within ₹1) · Enter bank figure · Not comparable · Limit differs · Bank higher · Bank lower ·
Card-EMI lock · Interest & charges · Below principal. Labels describe the *kind* of difference; none of them
implies FlowFi or the bank is wrong, and none triggers a change.

## What the screen does when data cannot be read
- **Loading:** a loading message until the first data and a server reachability reply arrive.
- **Genuinely empty:** "No credit cards, loans or EMIs found in your account" — shown only after the server has
  answered and nothing was returned.
- **Server unreachable:** a warning that FlowFi could not reach the server ("This does not mean your account is
  empty"); any figures shown come from data saved on the device and may be out of date.
- **Read error (for example permission denied):** an error banner saying figures may be incomplete.
