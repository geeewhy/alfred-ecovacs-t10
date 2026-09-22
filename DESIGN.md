# HQ Design System

## Direction

A very white, minimal local control surface with Linear-like discipline. It should feel like precise engineering software, not a consumer smart-home dashboard.

## Color

- Canvas: `oklch(0.992 0.002 250)`
- Primary surface: `oklch(0.978 0.003 250)`
- Strong text: `oklch(0.22 0.012 255)`
- Muted text: `oklch(0.52 0.012 255)`
- Hairline: `oklch(0.90 0.006 250)`
- Online: `oklch(0.63 0.14 155)`
- Selected/action: `oklch(0.55 0.17 265)`
- Caution/error colors appear only for actual state.

## Typography

Use the native sans-serif stack for interface copy. Use the native monospace stack for addresses, identifiers, versions, process IDs, and raw readings. Hierarchy comes from weight, spacing, and a restrained fixed scale.

## Layout

A narrow global rail and a broad content plane on desktop. Collapse to a compact top navigation on smaller screens. Use sections, rows, rules, and whitespace instead of card grids. Cap the useful content width without centering every region into a single marketing-page column.

## Components

- Status marks are small, labeled, and never color-only.
- Technical values use definition-list rows with stable alignment.
- Primary robot row is selectable and leads to Cockpit.
- Cockpit keeps the forward camera and LIDAR visible together, with terse live/source status in each sensor header.
- Sensor imagery stays inside neutral, square-edged technical planes; telemetry is rendered directly without ornamental radar effects.
- Cockpit controls use a single consistent button vocabulary and remain visibly non-operational until implemented.
- Loading uses quiet skeleton lines; failures preserve the last known layout.

## Motion

Only short state transitions around 160ms. No entrance choreography or decorative animation. Respect reduced motion when animation is added.
