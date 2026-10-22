---
name: Pi on Cloudflare
description: The owner's always-on coding agent, read and steered like a lab notebook.
colors:
  primary: "oklch(0.32 0.06 255)"
  primary-dark: "oklch(0.9 0.03 255)"
  primary-foreground: "oklch(0.985 0.002 250)"
  primary-foreground-dark: "oklch(0.22 0.02 250)"
  ring: "oklch(0.55 0.12 255)"
  ring-dark: "oklch(0.7 0.11 255)"
  background: "oklch(0.992 0.002 250)"
  background-dark: "oklch(0.2 0.012 250)"
  foreground: "oklch(0.2 0.02 250)"
  foreground-dark: "oklch(0.95 0.005 250)"
  muted: "oklch(0.962 0.006 250)"
  muted-dark: "oklch(0.25 0.014 250)"
  muted-foreground: "oklch(0.48 0.02 250)"
  muted-foreground-dark: "oklch(0.72 0.015 250)"
  accent: "oklch(0.945 0.012 250)"
  accent-dark: "oklch(0.29 0.02 250)"
  accent-foreground: "oklch(0.25 0.03 250)"
  accent-foreground-dark: "oklch(0.95 0.005 250)"
  border: "oklch(0.915 0.008 250)"
  border-dark: "oklch(0.32 0.016 250)"
  input: "oklch(0.88 0.01 250)"
  input-dark: "oklch(0.36 0.018 250)"
  success: "oklch(0.55 0.13 150)"
  success-dark: "oklch(0.74 0.14 150)"
  destructive: "oklch(0.53 0.2 27)"
  destructive-dark: "oklch(0.7 0.17 25)"
  backdrop: "oklch(0.2 0.02 250 / 0.4)"
  backdrop-dark: "oklch(0.1 0.01 250 / 0.6)"
typography:
  headline:
    fontFamily: 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif'
    fontSize: "1.125rem"
    fontWeight: 600
    lineHeight: 1.55
  title:
    fontFamily: 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif'
    fontSize: "0.875rem"
    fontWeight: 600
    lineHeight: 1.43
  body:
    fontFamily: 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif'
    fontSize: "0.9375rem"
    fontWeight: 400
    lineHeight: 1.55
  body-sm:
    fontFamily: 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif'
    fontSize: "0.875rem"
    fontWeight: 400
    lineHeight: 1.43
  label:
    fontFamily: 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif'
    fontSize: "0.75rem"
    fontWeight: 500
    lineHeight: 1.33
  mono:
    fontFamily: 'ui-monospace, "SF Mono", "JetBrains Mono", Menlo, Consolas, monospace'
    fontSize: "0.8125rem"
    fontWeight: 400
    lineHeight: 1.5
rounded:
  xs: "4px"
  sm: "6px"
  md: "8px"
  lg: "10px"
  full: "9999px"
spacing:
  "1": "4px"
  "1.5": "6px"
  "2": "8px"
  "3": "12px"
  "4": "16px"
  "6": "24px"
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.primary-foreground}"
    typography: "{typography.body-sm}"
    rounded: "{rounded.md}"
    padding: "0 16px"
    height: "36px"
  button-outline:
    backgroundColor: "{colors.background}"
    textColor: "{colors.foreground}"
    typography: "{typography.body-sm}"
    rounded: "{rounded.md}"
    padding: "0 16px"
    height: "36px"
  button-outline-hover:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.accent-foreground}"
  button-ghost-hover:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.accent-foreground}"
  button-destructive:
    textColor: "{colors.destructive}"
    typography: "{typography.body-sm}"
    rounded: "{rounded.md}"
    padding: "0 16px"
    height: "36px"
  button-sm:
    padding: "0 12px"
    height: "32px"
  input:
    backgroundColor: "{colors.background}"
    textColor: "{colors.foreground}"
    typography: "{typography.body-sm}"
    rounded: "{rounded.md}"
    padding: "0 12px"
    height: "36px"
  session-link:
    textColor: "{colors.foreground}"
    typography: "{typography.body-sm}"
    rounded: "{rounded.md}"
    padding: "8px 12px"
  session-link-active:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.accent-foreground}"
  owner-action-card:
    rounded: "{rounded.lg}"
    padding: "12px 16px"
  user-message:
    backgroundColor: "{colors.muted}"
    rounded: "{rounded.lg}"
    padding: "8px 16px"
---

# Design System: Pi on Cloudflare

## Overview

**Creative North Star: "The Lab Notebook"**

The app is a written record of work. A Session's transcript is the page: the agent's prose, its tool calls folded into bordered entries, the owner's messages set apart on a tinted wash, and notices ruled across the page like a dated margin note. Everything around the page (sidebar, header, composer) is quiet chrome in the same ink, there to find and steer the record, never to compete with it.

The palette is one hue: every gray, surface and accent is tinted toward blue-slate (hue 250–255), so light and dark themes read as the same notebook under different light. Structure comes from ruled lines and tonal steps, not shadows. The density is that of a working tool: 14 px interface text around a 15 px reading body, monospace for anything that is an identifier (slugs, repo paths, model IDs, code).

Color is scarce and always means something: Slate Ink marks the one main action, Signal Blue marks focus, Run Green marks work in progress, Brick Red marks failure and destruction.

**Key Characteristics:**

- One blue-slate hue across every neutral, in both themes, following the system setting.
- Flat surfaces separated by 1 px borders and tonal washes.
- 14 px interface text, 15 px reading text, monospace for identifiers.
- Outline and ghost controls by default; a filled button is the exception.
- A shadow means "this is waiting on you".

## Colors

A single cool, blue-slate family, light or dark by the system setting, with three signal colors used sparingly.

### Primary

- **Slate Ink** (`{colors.primary}` light, `{colors.primary-dark}` dark): the filled main button and nothing else. On dark it inverts to a pale ink with dark text (`{colors.primary-foreground-dark}`).
- **Signal Blue** (`{colors.ring}`, `{colors.ring-dark}`): focus outlines, the text caret, and text selection (at 28% mix). Never a fill.

### Neutral

- **Blue-Gray Paper** (`{colors.background}`): the light page and the fill of inputs and outline buttons.
- **Night Slate** (`{colors.background-dark}`): the dark page.
- **Ink** (`{colors.foreground}`, `{colors.foreground-dark}`): body text.
- **Faded Ink** (`{colors.muted-foreground}`, `{colors.muted-foreground-dark}`): secondary text, timestamps, section labels, hints, notices.
- **Tinted Wash** (`{colors.muted}` and `{colors.accent}`, with dark variants): `muted` fills the owner's messages, code, and tool output; `accent` is hover and the selected item in a list.
- **Ruled Line** (`{colors.border}`, `{colors.border-dark}`): every border and divider. **Input Line** (`{colors.input}`) is the slightly stronger border of fields and outline buttons.
- **Backdrop** (`{colors.backdrop}`, `{colors.backdrop-dark}`): the veil behind a dialog, and nothing else.

### Signal

- **Run Green** (`{colors.success}`, `{colors.success-dark}`): a running Session's pulsing dot and live status. Only for "working".
- **Brick Red** (`{colors.destructive}`, `{colors.destructive-dark}`): errors, failed runs, destructive buttons (text and a 40% border; a 10% wash on hover), the spend limit reached.

### Named Rules

**The One Hue Rule.** Every neutral is tinted to hue 250. A pure gray (`zinc`, `neutral`, `#888`) does not belong on any surface.

**The Signals Mean Something Rule.** Green is only "running", red only "failed or destroys". Neither is decoration, and neither is used for emphasis.

## Typography

**Body Font:** the system UI font (`ui-sans-serif, system-ui, -apple-system, "Segoe UI"`).
**Mono Font:** the system monospace (`ui-monospace, "SF Mono", "JetBrains Mono", Menlo, Consolas`).

**Character:** native and unbranded: it reads like the device's own tool, so long transcripts stay easy on any platform. Monospace is a semantic marker for identifiers, not a style.

### Hierarchy

- **Headline** (600, 18 px, 1.55): the title of a page (Workspaces, Settings) and of an empty state.
- **Title** (600, 14 px): the Session header, a Workspace card's name, a section heading in the sidebar and cards.
- **Body** (400, 15 px, 1.55): the transcript's prose and the base of the page. Markdown headings in it step up only to 16–18 px semibold.
- **Body small** (400, 14 px): all interface text: buttons, list items, form text, cards.
- **Label** (500, 12 px, Faded Ink): small section labels above a group ("Start a session in", "Container", "Sessions"), hints, field errors, timestamps.
- **Mono** (13 px in code blocks, 12 px in tool output, 0.85em inline): slugs, repo paths, model IDs, code, command output.

### Named Rules

**The Identifier Rule.** A value the owner could paste into a shell or a URL (slug, path, model ID, repo) is set in mono. A name meant for people (a Session title, a Workspace name) is not.

**The Two Sizes Rule.** Interface text is 14 px or 12 px. Reach for weight (500, 600) and Faded Ink before a new size.

## Layout

A two-column app shell at full viewport height (`100dvh`): a 288 px sidebar with a right border, and the main column. Below the `md` breakpoint (768 px) the two take turns: the Session list alone on `/`, and any page alone with a back arrow in its header.

Pages and the transcript sit in a centered column capped at `max-w-3xl` (768 px) with 16 px side padding and 24 px top and bottom. Headers are a single row, 16 px horizontal and 10 px vertical padding, over a bottom border. The Pane area (Tasks, later the Live View and Terminals) is a column to the right of the chat from `md` up, 384 px until dragged (288–720 px, kept per device), and takes the whole screen on a phone.

Spacing is a 4 px grid: 8 px between related controls, 12–16 px between groups inside a card, 24 px between page sections. Lists are tight (2 px between items, 8 × 12 px item padding).

## Elevation & Depth

Flat by default. Depth is drawn, not lit: a 1 px Ruled Line border, a step to Tinted Wash, or a horizontal rule. The only shadow is a small one (`shadow-sm`) under what waits on the owner: the Secret request and Browser Handoff cards above the composer, an open menu, and a dialog, over the Backdrop.

### Named Rules

**The Waiting-On-You Rule.** A shadow means the owner has to act. Anything that does not wait on the owner (cards, panels, lists, tool calls) stays flat. A menu or dialog waits on the owner while it is open.

## Shapes

Gently rounded, never pill-shaped except for dots and the composer's main button. Cards, the composer and the owner's messages use a 10 px radius; controls, list items, tool-call entries and code blocks 8 px; inline code 4 px; status dots, the scrollbar thumb and the composer's Send, Steer and Stop button are round. Borders are 1 px. Disclosures (thinking, tool calls, notices) use the native `details` element with a 14 px chevron that turns 90° when open.

## Components

### Buttons

Quiet and exact.

- **Shape:** gently rounded (8 px), 36 px high (32 px small, 36 px square for an icon), 14 px medium text, 16 px icon with an 8 px gap.
- **Primary:** Slate Ink fill. One per view at most: the action the view exists for.
- **Outline:** Input Line border on the page color; the default for actions in cards and lists ("Start", "Clone", "Save").
- **Ghost:** no border; for header and toolbar icons.
- **Destructive:** Brick Red text and a 40% Brick Red border, washing to 10% on hover. Never filled.
- **Hover / Focus:** a colour step to Tinted Wash (150 ms). Focus is a 2 px Signal Blue outline offset by 2 px. Disabled is 50% opacity.

### Inputs / Fields

- **Style:** 36 px high, Input Line border, page-colored fill, 8 px radius, 12 px padding, 14 px text; mono for identifier fields (slug, repo source).
- **Focus:** a 2 px Signal Blue ring.
- **Error:** `aria-invalid` and a 12 px Brick Red line under the field.
- **Select:** the platform's native `select`, styled the same, because it is the right picker on a phone. In the composer's toolbar a select is a chip instead (see Composer), still a native `select` underneath.

### Cards / Containers

- **Corner Style:** 10 px.
- **Background:** the page color; no fill of their own.
- **Shadow Strategy:** none, except the Waiting-On-You cards.
- **Border:** 1 px Ruled Line.
- **Internal Padding:** 16 px, with 16 px between sections.

### Navigation

The sidebar: a "Sessions" title and a "New session" outline button on one row, then the Sessions grouped by Workspace under 12 px group labels (the Workspace's name, so not mono), then Workspaces and Settings at the foot above a top border. A Session item is two lines: its title (14 px medium, truncated), then its repo in mono and either a pulsing Run Green dot with "Running" or a relative time. Hover and the current item use the Tinted Wash; the current item also has `aria-current="page"`.

### Menu

A ghost 32 px "⋯" trigger (`aria-haspopup="menu"`) opening the platform's popover (`popover`, top layer, light dismiss): a bordered 10 px panel at least 176 px wide, 4 px padding, `shadow-sm`, placed under the trigger's right edge and flipped to stay on screen. Items are 14 px with a 16 px icon, Tinted Wash on hover and focus, and the focus outline drawn inside the item; a destructive item is Brick Red with a 10% Brick Red wash, and ends in "…" when a confirm follows. Opening focuses the first item; arrows, Home and End move; Escape closes and gives focus back to the trigger. In the Session list the trigger sits on the row's right, shown on hover, focus or while open, and always on a touch screen (`pointer: coarse`).

### Dialog

The platform's modal `dialog` (`showModal`, focus trapped, Escape closes; a click on the backdrop closes it too): a bordered 10 px panel, at most 448 px wide and 16 px from the screen's edges, 20 px padding, `shadow-sm`, over the Backdrop. A 16 px semibold title that asks the question, a muted 14 px description, the body, then the actions: right-aligned on a row, stacked full width on a phone with the main action on top. A destructive confirm names what is lost and keeps Cancel focused; deleting a Workspace also asks for its slug typed in, and its button stays disabled until it matches.

### Composer

One bordered 10 px box at the foot of the transcript column, on the page color, its border turning Signal Blue while anything in it has the focus. The input comes first (15 px, growing to 192 px, then scrolling); under it a toolbar row:

- **Left:** the model and thinking level as quiet chips: 32 px high, 12 px Faded Ink text (the model ID in mono, the level after a brain icon) and a chevron, Tinted Wash on hover. Each is a native `select` laid invisibly over the chip, so a phone opens its own picker; on a touch screen the select reaches 6 px past the chip, above and below.
- **Right:** the Attach button (a ghost 32 px paperclip, opening the file picker for any number of files of any type), then the main button, a 32 px circle: Send (↑, Slate Ink) when idle; while a Run is in progress, Steer (↱, Slate Ink) with something typed and Stop (■, Brick Red outline) without, with a ghost Queue icon beside Steer and a "more ways to stop" menu (Stop all) beside Stop. On a touch screen each small control takes a 44 px touch through a transparent margin.

**Attachment tiles.** Inside the box, above the input, one tile per Attachment, wrapping: a picture is a 64 px square thumbnail (8 px radius, 1 px Ruled Line); any other file is a 64 px high row, 288 px wide at most, with a file icon on Tinted Wash, its name (14 px, truncated) and its size (12 px Faded Ink). A tile with something to say widens into that row, the thumbnail on its left: a failed upload in Brick Red (12 px, with a 40% Brick Red border), or why a picture goes as a file only, or a GIF as a still (12 px Faded Ink, two lines at most). The list is a polite live region, so a tile added or a failure is read out, its upload's percentage not. While a file uploads (one at a time; the others wait at 0%), a 4 px Faded Ink bar on Tinted Wash fills along the tile's foot (a `progressbar`), moving only where motion is allowed. Each tile has a round 20 px remove button, labelled "Remove name", over the thumbnail's corner or in the row's, centred in a transparent 44 px button that a touch hits anywhere and a fine pointer only on the circle. Send is disabled until every Attachment is uploaded and every picture fitted, the reason shown in Faded Ink under the box (and naming Send's description). A message the Session refuses comes back into the box, Attachments and all, with the reason under it in Brick Red.

**Dropping files.** A file dragged anywhere over the thread (a subagent's thread, for its own composer) turns the box's border Signal Blue and its fill Tinted Wash until it is dropped or leaves; there is no overlay. A file dropped elsewhere on the page is refused rather than opened in place of the app. Pasted files attach the same way.

Above the box, the queue lanes (Sending, Steering, Next up) as dashed 8 px rows under a 12 px label; a message with Attachments shows its text, then "Attached:" and their names. Under it, a 12 px line when a Slash command failed (Brick Red, `role="alert"`) or did something worth saying (Faded Ink).

**Completion menu.** Typing `/` at the start of the message, or `$` or `@` at the start of a word, opens a listbox that rises from the box's top edge, at its width and at most 288 px high: a bordered 10 px panel with `shadow-sm`, as an open menu has, sections under 12 px labels, and rows of the name in 13 px mono, its argument hint in 12 px mono Faded Ink, and a 12 px Faded Ink description, truncated. The input keeps the focus: ↑ and ↓ move the Tinted Wash highlight, Enter or Tab picks, Escape closes the menu until the trigger moves. Rows are 44 px on a touch screen. It fades and rises 4 px in over 150 ms, where motion is allowed. After `/` the sections are Commands, Prompt templates, then Skills (as `/skill:name`); after `$`, Skills alone, and no menu at all when none matches, so `$HOME` types on undisturbed. After `@`, Files: each row the name in 13 px mono (a folder's ending in `/`), then the folder it is in, 12 px mono Faded Ink, cut from its start (`…/src/chat/`) so the name stays whole on a phone. Until the Session first answers, when nothing matches, and when the search failed, the `@` menu holds a single line that cannot be picked, in 12 px Faded Ink: "Searching files…", "No matching files or folders." or "Could not search the files." (a live region, announced as it changes); Enter and Tab then type and send as usual, the arrows move the caret, and Escape closes it.

### Transcript

The owner's message is right-aligned on Tinted Wash (10 px radius, at most 85% wide), as typed, its images (an Attachment's) under the text at most 256 px high with an 8 px radius and a 1 px Ruled Line; the Skill a `/skill:` embedded in it follows the text as a closed disclosure labelled "Skill · name" (12 px Faded Ink, 14 px chevron), opening on the block the model got, mono on the page color and capped at 288 px high. The agent's message is unboxed prose. Thinking and tool calls are bordered disclosures, closed once done; output inside is mono on Tinted Wash, capped at 288 px high. Notices (Handoffs, compactions, Rollover requests) are a centered 12 px label between two hairlines, opening on demand.

### Pane Area

A column beside the transcript (a 1 px Ruled Line on its left, no shadow: it does not wait on the owner), or on a phone a full-screen sheet over the page. At the top, one row of tabs in a `tablist`: each tab is a 32 px pill (36 px on a phone) holding its label (14 px medium; an agent it is tied to after it in 12 px mono Faded Ink) and a 28 px close button with a 14 px X; the shown tab is on Tinted Wash with Ink text, the others Faded Ink washing on hover. The row scrolls sideways rather than wrapping. Under it the shown Pane fills the column; the others stay mounted, hidden. On its left edge a 12 px wide strip (not on a phone) is a keyboard-focusable `separator` that resizes the column: a 2 px line of Signal Blue appears on hover, drag and focus, and the arrow keys, Home and End move it.

### Waiting-On-You Card

The Secret request and Browser Handoff: a bordered 10 px card with a small shadow above the composer, a 14 px semibold line with an icon saying who needs what, the instruction, and the one action (a masked form, or "Open Live View") on the right.

## Do's and Don'ts

### Do:

- **Do** tint every new neutral to hue 250 in OKLCH, and give it a light and a dark value.
- **Do** use outline buttons for actions in lists and cards, and keep a filled Slate Ink button for the single main action of a view.
- **Do** set slugs, paths, repo names and model IDs in mono, and names meant for people in the UI font.
- **Do** style destructive actions as Brick Red text with a 40% border, and confirm them in words that say what will be lost.
- **Do** give every control a visible 2 px Signal Blue focus outline, and wrap any animation in `prefers-reduced-motion: no-preference`.
- **Do** make every view work at 390 px wide: one column, no sideways scroll.

### Don't:

- **Don't** add shadows to anything that is not waiting on the owner.
- **Don't** use Run Green or Brick Red for emphasis or decoration.
- **Don't** use raw Tailwind palette colors (`amber-500`, `zinc-*`): add a token in `styles.css` with light and dark values instead. The usage badge's `amber` "near limit" state is a known exception still to be turned into a warning token.
- **Don't** reference a color utility with no token behind it. `bg-card` is used by the Waiting-On-You cards but `--card` is not defined, so they currently render with no fill; define the token before relying on it.
- **Don't** let a header's controls push its title off screen on a phone: keep the Session header to its title and a few icon buttons; what steers the next request (model, thinking level) lives in the composer's toolbar.
