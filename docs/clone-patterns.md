# UI Clone Patterns

Battle-tested patterns from real cloning sessions. Every Phase 2 agent should read this before generating code.

## Header/Sticky Issues
- Sticky header MUST be a separate top-level component, not nested inside a wrapper
- Split into `<AnnouncementBar />` and `<MainHeader />` as siblings in page.tsx
- Announcement bar: NOT sticky, hides on scroll via height collapse
- Main header: `sticky top-0 z-50` with solid background color
- Using CSS variable z-index broke sticky - use Tailwind `z-50` instead

## Carousel/Product Cards
- Calculate exact card widths: (container - total gaps) / num_cards = no peek of extra card
- Box shadow clipping: use padding + negative margin + width:calc(100%+Xpx) trick
- Add `overflow-x: hidden` to body AND main to prevent horizontal scroll on mobile
- Mobile: add 16px horizontal padding to carousel containers for breathing room
- Navigation arrows: position within 1440px outer container, not at viewport edge
- Use `items-stretch` on carousel + `h-full` + `mt-auto` on button for consistent card heights

## Font Setup
- Use `next/font/google` for optimal loading (self-hosted, no external requests)
- Apply font via CSS variable on body, children inherit automatically

## Header Layout (Desktop)
- Use flex + `justify-between` with logo first, then nav, then utility icons — not centered 3-column grid
- Each group (logo, nav, icons) as separate flex children

## Dark Mode Removal
- Remove default Next.js `@media (prefers-color-scheme: dark)` from globals.css when cloning sites — it overrides white backgrounds

## Footer
- Constrain icon sizes with explicit w/h classes, not `w-auto h-auto`
- Payment icons: ~30px height, App store badges: 132x44px
- Link columns: use `flex-col` layout, not `flex-wrap` that breaks text across lines
- Bottom bar (social/copyright): separate full-width container outside the padded content area

## Collection Page / Filter Sidebar
- Filter sidebar: use `sticky top-[120px] self-start` on `<aside>` so it stays visible while the product grid scrolls
- Offset top value should match combined height of sticky header elements above (announcement bar + topbar + header)

## Mobile Drawer Patterns
- Image-based nav categories: implement as accordion with flex-wrap image grid (3+2 layout)
- App banner dismiss button should only hide the banner — not close the parent drawer
- CTA buttons (login/signup): use `inline-flex` for text-width sizing, not `flex` which forces full-width

## Mobile Sticky Bottom Bar
- When adding a `position: fixed` bottom bar on mobile (e.g., "ADD TO CART"), add `pb-[height] md:pb-0` to `<main>` to prevent footer content from being hidden behind the bar
