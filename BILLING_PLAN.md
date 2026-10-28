# Plan: charging third parties for catalogs and colour variants

Status: **plan, 28 October 2026 — decisions taken (see 'Decided'), being built.** Decisions taken by the owner the same day: billed
**monthly** (not prepaid), and **everything about it — prices, limits, bills — is managed from the
Platform Console** (the Gateway's dashboard, `D:\villy\api-super-admin`, where third-party clients
and their API keys already live).

## What the owner asked

Third parties call our catalog service (through the Gateway, with their own API key) to turn one
photo of a garment into a **four-view catalog** (front, back, side, sitting). They pay us for that.
If they want the **same garment in other colours** (colour variants, built 24 September), every extra
colour is an **extra charge**.

## What exists today

| Piece | State |
|---|---|
| Four-view catalog, colour variants | Built and working (`COLOUR_VARIANT_PLAN.md`). |
| `DrapeJob` rows (client, model, status, time) | Written per run, "for billing/auditing" — but no kind (catalog or colour) and nothing reads it for money. |
| Gateway `RequestLog` | Every request, with client and status code. Not usable as the bill: a catalog streams its answer, so the Gateway sees 200 even when the run fails half-way, and cannot tell a colour run from a normal one. |
| Gateway `Subscription` (plan, limits json) | Exists; no prices per unit, no bills. |
| Charging | **None.** Today a client could generate without limit, for free. |

## The rule that decides everything

**Only what was delivered is charged, and only once.** The catalog service is the only place that
knows a run delivered its four photos, and whether it was a normal catalog or a colour. So it writes
the charge; the Gateway prices it and bills it. A run that fails, times out or is cancelled by the
caller before the photos arrive costs nothing. A retry of the same request is never charged twice.

## Plan

### 1. Catalog service: one billable record per delivered run

New table `se_catalog.billable_runs` (new table only — nothing existing changes):

| Field | What |
|---|---|
| `id`, `clientId` | As `DrapeJob`; `clientId` from the Gateway header. |
| `kind` | `CATALOG` (a four-view catalog in the garment's own colour) or `COLOUR_VARIANT` (the same in a requested colour). Plain text, not a database enum. |
| `requestKey` | Unique. The caller's job id when it sends one, else the Gateway request id: the same request retried is one record. |
| `colourName`, `colourHex` | For a colour variant. |
| `garmentRef` | A hash of the uploaded garment photo, so colour runs can be shown under the garment they came from ("Banarasi red + 2 colours"). The photo itself is still never stored. |
| `views` | How many views were delivered (4 for a full catalog). |
| `gatewayRequestId`, `deliveredAt` | For matching against the Gateway's request log. |

Written in the same place the run is marked COMPLETED, after the last view is sent. Partial runs
(fewer views than asked) are recorded with their count and are charged only if the owner says so
(open question Q3).

A service-to-service route for the Gateway: `GET /internal/billing/usage?clientId&from&to` → counts
and lines per kind, per garment. Protected by the existing service key. Nothing for callers.

### 2. Platform Console (Gateway): prices, limits, usage, monthly bill

- **Prices** per client (default from their plan, overridable per client): price of one catalog,
  price of one colour variant, currency INR, whether GST is added. Kept as data with the date it took
  effect, so a price change never re-prices last month.
- **Monthly limit (recommended):** because billing is after the fact, a client could otherwise run up
  a large bill by mistake. An optional monthly cap in rupees or runs; at the cap, new runs are refused
  with a plain message ("This month's limit is reached. Ask ScaleEzy to raise it.") **before** any AI
  work starts. The check is cheap: a count of this month's records.
- **Usage page per client:** this month so far — catalogs, colour variants, amount — with the run
  list (date, kind, colour, garment, request id). Download as CSV.
- **Monthly bill:** on the 1st, one bill per client for the previous month: lines (catalogs × price,
  colour variants × price), GST if set, total. Statuses Draft → Sent → Paid, set from the console. A
  PDF to send. Re-running a month never makes a second bill.
- **Callers can see their own usage**: `GET /v1/usage` through the Gateway with their API key, so a
  client can check what they will be billed.

### 3. Tests (API-first, as for every change to this service)

On the local database, with the AI provider stubbed only in the harness that counts charges (the
generation itself is exercised by the existing suites), and **one** deliberate real paid run at the
end to prove a real delivery writes exactly one record:

- a catalog delivered → one `CATALOG` record; a colour run → one `COLOUR_VARIANT` record with its colour;
- failed / cancelled / timed-out run → no record; the same request retried → still one;
- two runs at once from one client → two records, no double count;
- monthly cap reached → refused before generation, nothing charged;
- prices changed mid-month → the bill uses the price each run was made under;
- the bill for a month made twice → one bill.

## Decided, 28 Oct 2026 (the owner: "do all the recommended things")

- **Q1 Prices**: set per client in the console; placeholders until then (₹100 a catalog, ₹60 a colour variant, marked as placeholders).
- **Q2 GST**: 18% added on top as its own line; a per-client switch turns it off.
- **Q3 Partial run**: free. Only a full four-view delivery is charged.
- **Q4 Monthly limit**: on by default at ₹5,000 per client, changeable per client in the console.
- **Q5 Scope**: only catalogs and colour variants for now; men's catalog, Design Studio and discovery later.

Status: being built (both repos, local database only), not deployed.

## Open questions for the owner (answered above)

- **Q1 Prices**: amounts per catalog and per colour (set in the console; placeholders until then).
- **Q2 GST** on these bills: added on top, or prices include it? (GST is optional for clients elsewhere.)
- **Q3 A partial run** (e.g. 3 of 4 views arrived): free, or charged pro rata?
- **Q4 Monthly cap**: on by default (with what default), or off unless set?
- **Q5 Men's catalog / Design Studio / discovery search**: charge them the same way later, or only
  catalogs and colour variants for now?
