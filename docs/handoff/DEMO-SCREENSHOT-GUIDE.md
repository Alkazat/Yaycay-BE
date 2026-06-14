# Walker demo — screenshot capture & verification guide

**Audience:** whoever logs into the customer app to verify screens and capture the
~15 marketing screenshots (`Yaycay-Website/IMAGE-BRIEFS-screenshots.md`).
**Account:** the seeded Walker family (see below). **App:** `Yaycay-FE`.

> This guide is keyed to the **exact data the BE seed created**. The canonical
> shot list/aesthetic still lives in `IMAGE-BRIEFS-screenshots.md`; this tells you
> how to *reach* each one with real data. Button/route names are the FE's, so
> where I say "open the trip" use whatever the app calls it.

---

## 0. Before you start

| Thing | Value |
|---|---|
| App | the customer app (`Yaycay-FE`, e.g. `app.yaycay…`) |
| Login | `demo.walker@yaycay.example` |
| Password | *(team vault — what you set as `DEMO_WALKER_PASSWORD`)* |
| Grown-ups PIN | *(team vault — `DEMO_WALKER_PIN`)* |
| Trip | **Singapore**, 4 days (12–15 May 2026), status complete, tier "Done for you" |
| Profiles | **Riley** (grown-up, holds PIN) · **Sam** (Explorer, 9) · **Pip** (Little, 6, tree-nut allergy) |

Capture hygiene (applies to every shot):
- Device frame: use a clean phone viewport (e.g. iPhone 15 width) unless the brief says desktop.
- **No banners**: the account is `is_demo` + paid, so there should be no paywall/onboarding nags. If one appears, screenshot it and tell BE.
- **Allergy wording check (critical):** every allergy element must show a **text label** (e.g. "Tree-nut allergy: flagged"), never colour alone, and must never say "safe"/"100%". If you see colour-only or "safe", stop and flag it.
- British/Australian English; money in **USD** (US$129 / US$59).

---

## 1. Planning chat (hero / brief #1 + #4)

**Goal:** the opening 3-question planning conversation, reopenable, with a
forwarded hotel-confirmation chip.

**Status:** ⚠️ **Depends on the chat backend store (ask #3, in progress).** Until
that ships + is populated, this screen has **no server data** to reopen — capture
it from FE fixture/mock state, or wait for the store. Everything below assumes the
store is live and seeded.

**Steps:** Log in → open the Singapore trip → open **Plan/Chat** → it should load
the prior thread (3 Q&A + the hotel-confirmation chip), not an empty composer.

**Verify:** 3 exchanges visible; the hotel chip renders as an "imported" card; you
can scroll the history.

**Frame:** the hero shot — show the chip + at least one Q&A pair.

---

## 2. Full multi-day itinerary (brief #2 / #5)

**Goal:** a scannable 4-day plan with per-child blocks and the Day-2 flag + rain marker.

**Steps:** Log in → open the Singapore trip → the itinerary/overview that lists
Days 1–4.

**Verify:**
- All four days present (Arrive & settle / Gardens by the Bay / Sentosa / River Wonders & home).
- Day 2 shows the per-child morning ("two adventures, one place"), a **tree-nut flag** on the lunch, and a **rain-plan marker** on the afternoon.

**Frame:** scroll so Day 2's flag + rain marker are visible in one shot.

---

## 3. Day-2 lunch / allergy meal card (brief #3)

**Goal:** the flagged Satay-by-the-Bay lunch with reasoning + checked/confirm rows.

**Steps:** Trip → **Day 2** → **midday / "Lunch at Satay by the Bay"** → open the
meal card ("Hawker lunch — Pip's tree-nut allergy flagged").

**Verify (all as text, not colour):**
- "Tree-nut allergy: flagged" label.
- "What we checked" + "Confirm on the day" reasoning.
- Lower-risk vs higher-risk stalls listed.
- Wording stays "flags/checks/reminders … final call stays with a grown-up" — **no "safe"**.

**Frame:** the full meal card with the flag + both reasoning rows.

---

## 4. Ask-the-kitchen / translation card (brief #8)

**Goal:** the bilingual tree-nut card.

**Steps:** same Day-2 lunch moment → open **"Ask-the-kitchen card (English + Mandarin)"**.

**Verify:** English line *and* the 中文 line both present; allergen ("nuts/nut
oils") shown as **bold text**; the "if unsure, treat as a no" line is there.

**Frame:** both languages in one shot.

---

## 5. During-trip companion / "what's nearby" (brief #6 / #12)

**Goal:** ask "what's good to eat near here" → 2 nearby options **with tree-nut
flags + confirm-on-the-day notes**, plus a one-tap rain plan.

**Status:** ⚠️ **Depends on the companion backend store (ask #3).** Until seeded,
use FE fixture state.

**Steps:** Open the trip in "during trip"/companion mode → ask the nearby-food
question → see 2 flagged options + the rain-plan affordance.

**Verify:** both options carry a **tree-nut flag** + "confirm before you order"
note; rain plan is one tap.

**Frame:** the answer card with both options + rain-plan button.

---

## 6. Shared / family day view (brief #7)

**Goal:** a clean, readable shared day.

**Steps:** Trip → **Day 2** → the **shared/family** view (read-friendly, not a
single child's mode).

**Verify:** morning (both kids), lunch (with flag), afternoon (rain plan), evening
(pool) read cleanly top to bottom.

**Frame:** the shared Day-2 column.

---

## 7. Per-child adventure (Sam vs Pip) — supports #2/#7

**Goal:** same place, two adventures.

**Steps:** Trip → Day 2 → morning "Gardens by the Bay" → switch the active profile
between **Sam** (see the Supertree engineering quest + quiz) and **Pip** (see the
Cloud Forest hidden-creatures trail). The block content should change with the
profile.

**Frame:** one shot as Sam, one as Pip (good for the "two adventures" story).

---

## 8. PIN gate (brief — "Grown-ups only")

**Goal:** the 4-digit entry screen.

**Steps:** From a child profile (Sam or Pip) active, tap into **Grown-ups** → the
PIN gate appears.

**Verify:** 4-digit entry, "Grown-ups only" framing; a child profile **cannot**
bypass it.

**Frame:** the PIN pad before entry.

---

## 9. Grown-ups command centre (brief #6-grownups)

**Goal:** the PIN-unlocked guardian view.

**Steps:** At the PIN gate, enter the vault PIN → the command centre.

**Verify:**
- **EpiPen/allergy protocol** banner (from the trip's grown-ups `essentials`:
  carry 2× EpiPen, give adrenaline then call 995, nearest hospital).
- The **checklist** (pack EpiPen, show the kitchen card, confirm with staff, etc.).
- Transport notes (MRT/Grab).

**Frame:** protocol banner + checklist visible.

---

## 10. Meal-time reminder (brief #9)

**Goal:** a pre-meal reminder with venue + flags + "confirm before you order".

**Steps:** This is typically a time-triggered card around the Day-2 lunch. If the
FE renders it from the meal's `safety` flags, open the Day-2 lunch reminder; if
it's a notification, trigger/preview it per the FE's mechanism.

**Verify:** venue (Satay by the Bay), the tree-nut flag (amber row **with a text
label**), and a "confirm before you order" checklist line.

**Frame:** the reminder card.

---

## Keepsake / journal (referenced by keepsake imagery)

**Steps:** Trip → **Pip's** profile → Journal/Keepsake → Pip's Day-2 page ("Today I
saw the giant trees…").

**Verify:** the page renders with Pip's entry. (No photos — synthetic only.)

---

## If a screen is empty or wrong

The seed guarantees the **data** exists for shots 2, 3, 4, 6, 7, 8, 9, 10 and the
journal. Shots **1 (chat)** and **5 (companion)** need the chat/companion store
(ask #3) or FE fixtures. If anything else is empty, dead-ends, or shows
colour-only allergy state / the word "safe", capture it and send it to the BE
thread — it's either a seed-content tweak (BE) or a render gap (FE).
