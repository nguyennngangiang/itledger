---
name: IT Ledger
description: The system of record for company IT hardware — a calm, aurora-lit workspace where a tedious chore feels alive.
colors:
  accent: "#7c74e8"
  accent-hover: "#6b63dd"
  accent-active: "#5b52c9"
  accent-bg: "#eeecfd"
  accent-border: "#d6d2f7"
  aurora-fuchsia: "#d946ef"
  aurora-violet: "#a855f7"
  aurora-indigo: "#4f46e5"
  bg: "#f5f4fb"
  surface: "#ffffff"
  surface-muted: "#f7f5fd"
  topbar-bg: "#eceafb"
  text: "#2b2740"
  text-muted: "#6b6785"
  text-faint: "#a5a1bb"
  border: "#ece9f5"
  border-strong: "#dcd8ec"
  success: "#16a34a"
  success-bg: "#dcfce7"
  warning: "#d97706"
  warning-bg: "#fef3c7"
  danger: "#dc2626"
  danger-bg: "#fee2e2"
typography:
  display:
    fontFamily: "Inter, system-ui, 'Segoe UI', Roboto, sans-serif"
    fontSize: "32px"
    fontWeight: 800
    lineHeight: 1.1
    letterSpacing: "-0.02em"
  headline:
    fontFamily: "Inter, system-ui, 'Segoe UI', Roboto, sans-serif"
    fontSize: "22px"
    fontWeight: 700
    lineHeight: 1.25
    letterSpacing: "-0.01em"
  title:
    fontFamily: "Inter, system-ui, 'Segoe UI', Roboto, sans-serif"
    fontSize: "15px"
    fontWeight: 600
    lineHeight: 1.3
    letterSpacing: "normal"
  body:
    fontFamily: "Inter, system-ui, 'Segoe UI', Roboto, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: "normal"
  label:
    fontFamily: "Inter, system-ui, 'Segoe UI', Roboto, sans-serif"
    fontSize: "12px"
    fontWeight: 600
    lineHeight: 1.4
    letterSpacing: "0.04em"
rounded:
  sm: "8px"
  md: "12px"
  lg: "16px"
  pill: "999px"
spacing:
  xs: "6px"
  sm: "8px"
  md: "16px"
  lg: "24px"
  xl: "32px"
components:
  button-primary:
    backgroundColor: "{colors.accent}"
    textColor: "#ffffff"
    rounded: "{rounded.sm}"
    padding: "0 16px"
    height: "38px"
  button-quick-add:
    backgroundColor: "{colors.accent-bg}"
    textColor: "{colors.accent}"
    rounded: "{rounded.sm}"
    padding: "0 12px"
    height: "34px"
  button-quick-add-hover:
    backgroundColor: "{colors.accent}"
    textColor: "#ffffff"
  card:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    rounded: "{rounded.lg}"
    padding: "16px 20px"
  chip:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text-muted}"
    rounded: "{rounded.pill}"
    padding: "0 12px"
    height: "32px"
  chip-active:
    backgroundColor: "{colors.accent-bg}"
    textColor: "{colors.accent}"
  pill-accent:
    backgroundColor: "{colors.accent-bg}"
    textColor: "{colors.accent}"
    rounded: "{rounded.pill}"
    padding: "3px 10px"
  input:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    rounded: "{rounded.sm}"
  nav-item-active:
    backgroundColor: "{colors.accent}"
    textColor: "#ffffff"
    rounded: "{rounded.sm}"
---

# Design System: IT Ledger

## 1. Overview

**Creative North Star: "The Aurora Workspace"**

IT Ledger is a workspace that shimmers. The base is quiet, credible enterprise software — Inter type, a lavender-tinted field, generous whitespace, tables that mean business — but the whole surface is lit from within by a periwinkle-to-fuchsia aurora that appears in the moments that matter: the active nav pill, a KPI, a relevance meter, a hover glow. The strategic reason is direct: a ledger only reports accurately if people keep it current, and people only keep it current if opening the tool feels good. Delight here is not decoration; it is the mechanism that keeps the data alive.

The register is a **product** UI — design serves the task. The IT team lives in it daily and needs speed and density; managers drop in occasionally and must understand the fleet at a glance without training. So the calm always wins the argument with the sparkle: controls are refined and understated, motion is brief and state-bearing, and the aurora is a rare accent, never a wash across every panel.

This system explicitly rejects three things. It is **not a dense legacy admin panel** — no cluttered gray SAP/ServiceNow intimidation. It is **not a raw spreadsheet** — a device is never a bare row; it carries the story of its owner, repairs, and handovers. And it is **not generic AI-dashboard slop** — the periwinkle→fuchsia gradient is an earned signature confined to a few live elements, never the purple-gradient hero-metric template stamped onto identical cards.

**Key Characteristics:**
- Lavender-tinted light base (`#f5f4fb`) with frosted-glass panels floating above a soft radial-gradient field.
- One committed brand hue — periwinkle `#7c74e8` — carrying every action, selection, and state cue.
- A periwinkle→fuchsia aurora gradient reserved for signature moments (active nav, KPIs, relevance meters, primary CTA).
- Inter throughout; a fixed rem-ish scale, not fluid clamps.
- Soft, always-present depth that deepens on interaction.
- Refined-and-calm components; delight arrives through motion and light, not loud controls.
- Motion is first-class but every effect has a `prefers-reduced-motion` fallback.

## 2. Colors

A committed periwinkle identity resting on lavender-tinted neutrals, with a fuchsia companion that only ever appears inside a gradient with periwinkle — never alone.

### Primary
- **Periwinkle** (`#7c74e8`): The single brand voice. Primary actions, current selection, focus rings, links, status accents, and every "this is active" cue. Hover deepens to `#6b63dd`, active to `#5b52c9`.
- **Periwinkle Wash** (`#eeecfd`, border `#d6d2f7`): The soft fill behind accent pills, chips-when-active, quick-add buttons at rest, and the avatar — periwinkle at low volume for tinted surfaces.

### Secondary
- **Aurora Fuchsia** (`#d946ef`) and **Aurora Violet** (`#a855f7`): Gradient companions only. They light the tail end of the periwinkle→fuchsia gradient used on the active nav pill, KPI numerals, the primary-button sheen, and the relevance meter. They are never used as a flat standalone fill.
- **Aurora Indigo** (`#4f46e5`): The gradient's deep anchor — the logo mark and the leading edge of the KPI gradient.

### Neutral
- **Ink** (`#2b2740`): Primary text — a deep indigo-slate, not black, so it belongs to the lavender world. Meets AA on all surfaces.
- **Muted Ink** (`#6b6785`): Secondary text, labels, subtitles, table meta.
- **Faint Ink** (`#a5a1bb`): Hints and disabled affordances only — never body copy.
- **Field** (`#f5f4fb`) / **Surface** (`#ffffff`) / **Surface Muted** (`#f7f5fd`) / **Topbar** (`#eceafb`): The layered surface stack, coolest at the app field, brightest at the card.
- **Border** (`#ece9f5`) / **Border Strong** (`#dcd8ec`): Hairline dividers and stronger control outlines.

### Semantic
- **Success** (`#16a34a` on `#dcfce7`), **Warning** (`#d97706` on `#fef3c7`), **Danger** (`#dc2626` on `#fee2e2`): Standard status vocabulary for pills, form errors, and the trash-mode toggle.

### Named Rules
**The One Voice Rule.** Periwinkle `#7c74e8` is the only accent. Everything interactive speaks in it; nothing competes with it.

**The Aurora-Only-In-Gradient Rule.** Fuchsia and violet exist *only* as the far end of a periwinkle gradient, on a small set of signature elements. A flat fuchsia button or a standalone violet fill is forbidden — that is the AI-slop tell this brand rejects.

## 3. Typography

**Display Font:** Inter (with `system-ui, 'Segoe UI', Roboto, sans-serif`)
**Body Font:** Inter (single family, multiple weights)
**Label/Mono Font:** Inter

**Character:** One well-tuned humanist sans carries the entire product — headings, data, labels, and body. Contrast comes from weight (400→800) and size, not from pairing. Negative tracking on the larger sizes keeps headings tight and composed; the base sits at 14px because this is a dense tool viewed at a consistent desk DPI.

### Hierarchy
- **Display** (800, 32px, line-height 1.1, tracking -0.02em): Dashboard KPI numerals only. The single place gradient-clipped text is permitted.
- **Headline** (700, 22px, line-height 1.25, tracking -0.01em): Page titles in the sub-header.
- **Title** (600, 15px): Panel titles, quick-action titles, card headings.
- **Body** (400, 14px, line-height 1.5): Default UI text and prose. Cap prose at 65–75ch; dense tables may run wider.
- **Label** (600, 12px, tracking 0.04em, UPPERCASE): Table column headers and micro-labels only.

### Named Rules
**The One Family Rule.** Inter does all the work. No display face, no serif, no second sans. Hierarchy is weight and size.

**The Fixed-Scale Rule.** Type sizes are fixed steps, not fluid `clamp()`. A KPI must read identically in a narrow panel and a wide one.

## 4. Elevation

Depth is always present and always soft. Panels and cards rest as frosted glass — translucent white over the aurora field with `backdrop-filter: blur(6–10px)` — carrying a gentle two-part shadow at rest: a tight neutral drop plus a wide, low-opacity periwinkle-tinted glow. On hover the card lifts (`translateY(-3px)`) and the glow intensifies and warms toward periwinkle. Depth reinforces the aurora identity; the tint in the shadow is the point.

### Shadow Vocabulary
- **Ambient small** (`0 1px 2px rgba(15,23,42,.04), 0 1px 3px rgba(15,23,42,.06)`): resting cards, inputs.
- **Ambient medium** (`0 4px 12px -2px rgba(15,23,42,.08), 0 2px 6px -2px rgba(15,23,42,.05)`): hovered cards, popovers.
- **Lifted large** (`0 20px 40px -12px rgba(15,23,42,.22)`): modals, the loading card.
- **Aurora glow** (`0 10px 34px -22px rgba(124,116,232,.5)` → deepening to `.65` on hover): the periwinkle-tinted companion glow on panels, stat cards, the active nav pill, and primary buttons.

### Named Rules
**The Tinted-Glow Rule.** Every meaningful elevation pairs a neutral drop shadow with a periwinkle-tinted glow. A pure gray shadow with no aurora tint reads as a different, colder product.

**The Glass-Panel Rule.** Content surfaces are translucent glass over the field, not opaque blocks. `backdrop-filter` blur is a defining material, not a decorative flourish — but it lives on structural panels, never on tiny controls.

## 5. Components

Components are **refined and calm**: quiet at rest, responsive on interaction, consistent screen to screen. The delight is in the transition, not the shape.

### Buttons
- **Shape:** Gently curved, 8px radius (`{rounded.sm}`).
- **Primary:** Periwinkle→fuchsia gradient fill (`120deg, #8b83f0, #7c74e8 45%, #a855f7`), white text, aurora glow. On hover the gradient shifts position and a diagonal sheen sweeps across; the button rises 1px. This is the one loud control, reserved for the primary action in a modal or toolbar.
- **Quick-add (secondary):** Periwinkle-wash fill, periwinkle text, thin periwinkle border. Fills solid periwinkle with white text and a glow-lift on hover. Used for the top-bar add actions.
- **Ghost / icon triggers:** Faint-ink icon that warms to periwinkle on hover (info bubbles, "why matched", table actions).

### Chips
- **Status filter chips:** Pill-shaped (`999px`), white fill, muted-ink text, hairline border, with a small count badge. Active state switches to periwinkle-wash fill, periwinkle text and border, and a leading colored dot.
- **Suggestion / assistant chips:** Periwinkle-wash pills that invert to solid periwinkle on hover.

### Cards / Containers
- **Corner Style:** 16px (`{rounded.lg}`) on panels and stat cards.
- **Background:** Translucent white glass (`rgba(255,255,255,.82–.9)`) with `backdrop-filter: blur(6px)` over the aurora field.
- **Shadow Strategy:** Ambient small + aurora glow at rest (see Elevation); lifts and deepens on hover. Stat cards add a one-off diagonal shine sweep on hover.
- **Border:** A near-white translucent hairline (`rgba(255,255,255,.7)`) that reads as the glass edge.
- **Internal Padding:** 20px on cards, 16–20px on panel heads.

### Inputs / Fields
- **Style:** White fill, hairline border, 8px radius. Provided by Ant Design, tuned to the token palette.
- **Focus:** Periwinkle border with the periwinkle `--ring` glow (`rgba(124,116,232,.2)`).
- **Error:** Danger text on danger-wash (`#fee2e2`) in a rounded block below the field group. Required marks use danger.

### Navigation
- **Style:** A single glassy top bar (no sidebar) — translucent topbar fill with `backdrop-filter: blur(10px)`. Nav items are 500-weight, muted-ink, 9px radius, transparent at rest; hover tints periwinkle-wash.
- **Active:** A single **sliding indicator pill** — a periwinkle→fuchsia gradient with an aurora glow — animated (anime.js) to slide under the active tab on every switch. The label goes white and gains a soft text-shadow.
- **Mobile:** Below 760px the bar wraps and the nav becomes its own horizontally scrolling row; labels hide below 860px, leaving icons.

### Signature: The Relevance Meter
The Smart (semantic) search result carries a slim aurora meter: a muted track with a periwinkle→fuchsia fill whose width maps to the relevance score, a bold periwinkle percentage, and a "why this matched?" trigger that opens an evidence popover with highlighted phrases. This is the clearest expression of the aurora identity doing real informational work — the gradient *means* something here.

## 6. Do's and Don'ts

### Do:
- **Do** keep periwinkle `#7c74e8` as the only accent — one voice for every action, selection, and state (The One Voice Rule).
- **Do** confine the periwinkle→fuchsia aurora gradient to signature moments: active nav, KPI numerals, the primary CTA, the relevance meter. It should feel rare and earned.
- **Do** float content on frosted-glass panels with a periwinkle-tinted glow shadow; pair every elevation with the aurora tint (The Tinted-Glow Rule).
- **Do** use Inter at fixed sizes and let weight (400–800) carry hierarchy (The One Family Rule).
- **Do** keep body ink at `#2b2740` for AA contrast; reserve faint ink `#a5a1bb` for hints and disabled states only, never body copy.
- **Do** give every device its story — surface owner, maintenance, and handover context (info bubbles, transfer cells), never a bare grid.
- **Do** ship a `prefers-reduced-motion` fallback for every animation (crossfade or instant) — the sparkle field, logo pulse, chart zoom, and nav slide already have theirs.

### Don't:
- **Don't** let the dashboard collapse into **generic AI-dashboard slop**: the purple-gradient hero-metric template, identical icon+title+text card grids, or decorative gradient fluff. KPI gradient numerals are the *one* sanctioned gradient-text use; do not spread `background-clip: text` beyond them.
- **Don't** use fuchsia or violet as a flat, standalone color — they exist only inside a periwinkle gradient (The Aurora-Only-In-Gradient Rule).
- **Don't** build a **dense legacy admin panel**: no cluttered gray SAP/ServiceNow chrome, no wall of uniform controls with no breathing room.
- **Don't** reduce a device to a **raw spreadsheet** row — no context-free grid of cells.
- **Don't** introduce a second font family, a serif display face, or fluid `clamp()` headings.
- **Don't** put `backdrop-filter` blur on tiny controls or scatter loud motion across every surface; the base must stay calm so the aurora moments land.
- **Don't** ship a pure gray shadow with no periwinkle tint — it makes the surface read as a colder, off-brand product.
