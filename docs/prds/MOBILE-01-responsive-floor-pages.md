# MOBILE-01: Responsive Manufacturing Floor Pages

## Overview
Make three core pages usable on tablets and phones for operators working on the manufacturing line: **SPU Dashboard**, **Work Instructions (WI-01/WI-02)**, and **Parts/Inventory**.

These are not separate routes — the existing pages become responsive with mobile-optimized layouts that activate at tablet/phone breakpoints.

## Target Devices
- **Primary**: iPad / Android tablet (landscape, ~1024px) — mounted at workstations
- **Secondary**: iPhone / Android phone (portrait, ~375-430px) — walking the floor
- **Glove-friendly**: Min touch target 56px height, 12px gap between interactive elements

## Current State
- All three pages are desktop-only (2-6 responsive breakpoints total across all files)
- Tables don't scroll horizontally on small screens
- Buttons and inputs are too small for glove use
- No scan-first navigation pattern
- Sidebar nav takes up space on small screens

---

## Page 1: SPU Dashboard (`/spu`)

### Problems on Mobile
- Status filter tabs overflow horizontally with no scroll
- SPU cards/table too wide for phone screens
- Register form has small inputs
- Barcode scanner section is buried
- Fleet view cards don't stack properly

### Stories

#### MOBILE-01-S1: Responsive Status Tabs
- **As an** operator, **I want** to swipe through status filter tabs on my phone
- Tabs become horizontally scrollable on screens < 768px
- Active tab stays visible (scroll-into-view)
- Touch target: 48px height minimum

#### MOBILE-01-S2: SPU List Card View (Mobile)
- **As an** operator, **I want** to see SPUs as stacked cards on my phone instead of a table
- Below 768px: switch from table rows to card layout
- Each card shows: UDI (large, tappable), status badge, created date
- Tap card → navigate to SPU detail
- Above 768px: keep current table view

#### MOBILE-01-S3: Scan-First Layout
- **As an** operator, **I want** the barcode scanner to be the first thing I see on mobile
- Below 1024px: move barcode scan section to top of page (above tabs and list)
- Large scan input with 56px height
- Auto-focus on page load (mobile only)
- On successful scan: navigate directly to SPU detail page

#### MOBILE-01-S4: Collapsible Register Form
- **As an** operator, **I want** the registration form hidden by default on mobile
- Below 768px: "Register New SPU" becomes a collapsible accordion (closed by default)
- Form inputs: full-width, 48px height minimum
- Submit button: full-width, 56px height, bold

#### MOBILE-01-S5: Responsive Filters
- **As an** operator, **I want** filters to not eat my screen space
- Below 768px: filters collapse into a "Filters" button that opens a slide-up sheet
- Filter sheet: full-width selects, large clear/apply buttons
- Active filter count shown on the button badge

---

## Page 2: Work Instructions (`/spu/manufacturing/wi-01` & `/spu/manufacturing/wi-02`)

### Problems on Mobile
- Multi-step workflow doesn't show progress clearly on small screens
- Input fields and buttons too small for gloved hands
- Barcode scan inputs aren't optimized for camera scan
- Step notes and photos hard to view/add on mobile
- No haptic/audio feedback on actions

### Stories

#### MOBILE-01-S6: Full-Width Step Flow
- **As an** operator, **I want** to see one step at a time on my phone
- Below 768px: each workflow step takes full screen width
- Large step number and title at top
- "Previous" / "Next" navigation buttons: 56px height, full width
- Progress indicator: horizontal dots or fraction (Step 3 of 7)

#### MOBILE-01-S7: Glove-Friendly Inputs
- **As an** operator, **I want** all inputs to be easy to tap with gloves
- All text inputs: min-height 56px, font-size 18px
- All buttons: min-height 56px, min-width 56px
- Select dropdowns: 56px height
- Spacing between interactive elements: 12px minimum

#### MOBILE-01-S8: Camera Scan Integration
- **As an** operator, **I want** to scan barcodes with my tablet camera during work instructions
- Scan button next to barcode input fields opens camera overlay
- Use `BarcodeDetector` API (Chrome/Safari) or `quagga2` fallback
- On successful scan: auto-fill input, haptic buzz, green flash
- On failure: red flash, error beep, retry prompt

#### MOBILE-01-S9: Photo Capture for Quality Steps
- **As an** operator, **I want** to take photos during inspection steps
- Camera button on quality/inspection steps
- Capture → preview → confirm → attach to step record
- Photos stored in SPU document record
- Thumbnail preview in step history

#### MOBILE-01-S10: Audio/Haptic Feedback
- **As an** operator, **I want** confirmation feedback I can feel/hear on the noisy floor
- Success action: short vibration (100ms) + optional success tone
- Error: double vibration (200ms-100ms-200ms) + error tone
- Use `navigator.vibrate()` API
- Audio toggle in settings (respect quiet environments)

#### MOBILE-01-S11: Operator Quick-ID Per Step
- **As an** operator, **I want** to identify myself quickly per step without full login
- Optional 4-digit PIN entry per critical step (e.g., QC sign-off)
- PIN maps to user account for audit trail
- Configurable: which steps require operator ID
- Stores `completedBy` with timestamp on each step record

---

## Page 3: Parts / Inventory (`/spu/parts`)

### Problems on Mobile
- Table with 10+ columns is unusable on phone
- Search bar and tab navigation overflow
- Part detail links too small to tap
- Inventory counts hard to read at a glance
- Cart/low-inventory tabs not obvious on mobile

### Stories

#### MOBILE-01-S12: Responsive Parts Table → Card List
- **As an** operator, **I want** to see parts as cards on my phone
- Below 768px: switch table to card layout
- Each card shows: Part # (bold), Name, Inventory Count (large, color-coded), Supplier
- Red highlight for zero/low inventory
- Tap card → navigate to part detail

#### MOBILE-01-S13: Sticky Search Bar
- **As an** operator, **I want** search to stay visible as I scroll parts
- Search bar: sticky top on mobile, 56px height
- Instant filter as-you-type (already works, just needs sizing)

#### MOBILE-01-S14: Inventory Quick-Update
- **As an** operator, **I want** to quickly update inventory count from the list
- Swipe or tap "adjust" on a part card → inline +/- stepper
- Stepper buttons: 56px × 56px, bold +/- icons
- Creates inventory transaction record on confirm
- No navigation away from list required

#### MOBILE-01-S15: Low Inventory Alert Cards
- **As an** operator, **I want** low inventory items to stand out immediately
- Below 768px: Low inventory tab shows as alert-style cards
- Large red/orange count number
- "Reorder needed" label on critical items
- Sortable by urgency (zero stock first)

#### MOBILE-01-S16: Tab Navigation Scroll
- **As an** operator, **I want** to swipe between All Parts / Low Inventory / Cart tabs
- Tabs: horizontally scrollable on mobile
- Swipe gesture between tabs (optional enhancement)
- Active tab indicator visible

---

## Global / Shared Stories

#### MOBILE-01-S17: Responsive Sidebar Nav
- **As an** operator, **I want** the sidebar to not eat my screen on tablet/phone
- Below 1024px: sidebar collapses to hamburger menu
- Slide-out overlay on tap
- Current page highlighted
- Quick-access shortcuts: Dashboard, WI-01, WI-02, Parts

#### MOBILE-01-S18: PWA Manifest
- **As an** operator, **I want** to install BIMS as an app on my tablet
- Add `manifest.json` with app name, icons, theme color
- `display: "standalone"` for full-screen experience
- Start URL: `/spu` (dashboard)
- Theme color matches TRON dark theme

#### MOBILE-01-S19: Viewport & Touch Optimization
- **As a** developer, **I want** proper mobile viewport and touch behavior
- `<meta name="viewport" content="width=device-width, initial-scale=1, user-scalable=no">`
- Disable double-tap zoom on interactive areas
- `touch-action: manipulation` on buttons/inputs
- `-webkit-tap-highlight-color: transparent`

#### MOBILE-01-S20: Responsive Utility Classes
- **As a** developer, **I want** shared responsive utility patterns
- Create `src/lib/styles/responsive.css` with:
  - `.touch-target` — min 56px height, proper spacing
  - `.mobile-card` — card layout for table replacement
  - `.mobile-hidden` / `.desktop-hidden` — breakpoint toggles
  - `.scroll-tabs` — horizontal scrollable tab container

---

## Implementation Priority

| Phase | Stories | Effort | Impact |
|-------|---------|--------|--------|
| **Phase 1** | S17, S19, S20 (foundation) | 1 day | Unblocks everything |
| **Phase 2** | S1, S2, S3, S4, S5 (SPU Dashboard) | 2 days | Most-used page |
| **Phase 3** | S6, S7, S8, S10 (Work Instructions) | 2 days | Assembly line critical |
| **Phase 4** | S12, S13, S14, S15, S16 (Parts) | 1.5 days | Inventory management |
| **Phase 5** | S9, S11, S18 (polish: photos, PIN, PWA) | 1.5 days | Quality + install |

## Technical Notes

- **No new routes** — all changes are responsive CSS + conditional rendering on existing pages
- **Tailwind breakpoints**: `sm:` (640px), `md:` (768px), `lg:` (1024px) — already available
- **BarcodeDetector API**: Native in Chrome 83+, Safari 17.2+ — covers all modern tablets
- **Vibration API**: Android only (iOS ignores `navigator.vibrate()`) — degrade gracefully
- **PWA**: Use `@vite-pwa/sveltekit` plugin for service worker + manifest generation
- **Testing**: Use Chrome DevTools device toolbar + real iPad for final validation

## Out of Scope (Future)
- Offline-first with sync queue (requires service worker + IndexedDB)
- Station kiosk mode / auto-lock
- Multi-language (i18n)
- TV/monitor dashboard mode
- Bluetooth barcode scanner pairing
