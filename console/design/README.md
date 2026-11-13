# idea design system

One stylesheet, `idea.css`, used by every idea surface: the installer page, the setup and
console pages served by the controller, and the dsh `idea` panel. No build step and no
external requests: fonts are vendored in `fonts/`.

Open `../preview/*.html` in a browser to see every component on real pages.

## Principles

- Neutral first. Gray scale does the work; color only means something (status, focus).
- One accent (blue) for focus rings, links and "running". Primary buttons are ink
  (black in light mode, white in dark mode), not colored.
- Thin 1px borders instead of shadows. Shadows only for things that float (menus, popovers).
- Tables and lists over cards when showing many items.
- Few words. A label, one hint line at most, no decoration, no emoji.
- Light and dark from the same tokens (`prefers-color-scheme`, or `data-theme` on `<html>`).
- Works at 360px wide.

## Tokens

| Group | Tokens |
| --- | --- |
| Neutrals | `--bg` `--bg-subtle` `--surface` `--surface-hover` `--border` `--border-strong` `--fg` `--fg-muted` `--fg-subtle` |
| Accent | `--accent` `--accent-soft` |
| Status | `--ok` `--warn` `--bad` and their `-soft` backgrounds |
| Type | `--font-sans` (Pretendard), `--font-mono` (Geist Mono); sizes `--text-xs` 12 to `--text-2xl` 24 |
| Space | `--s1` 4px … `--s12` 48px (4px grid) |
| Shape | `--radius-sm` 4, `--radius` 6, `--radius-lg` 8 |

Never hard-code a color or a size in a page; add a token instead.

## Components

| Class | Use |
| --- | --- |
| `.topbar` `.brand` | Top bar with the product mark and main navigation |
| `.shell` `.sidebar` `.nav-item` | Project list on the left, content on the right |
| `.page` `.page-narrow` `.page-head` | Page width and the title row |
| `.card` `.card-head` `.card-body` `.card-foot` | Grouped settings; the footer holds the save button |
| `.btn` `.btn-primary` `.btn-ghost` `.btn-danger` `.btn-sm` | One primary button per view |
| `.field` `.label` `.input` `.hint` `.field-error` `.code-input` | Forms |
| `.choice` | Radio cards (disk chooser) |
| `.badge` `-ok` `-warn` `-bad` `-run` | Status. Task states map to: running = run, waiting for tests = warn, merged = ok, failed = bad |
| `.alert` `-ok` `-warn` `-bad` | Page-level messages |
| `.kv` `.copy` | Key/value lists with a copy button |
| `.table` | Lists of tasks, devices, projects |
| `.tabs` | Filters over one list |
| `.log` | Agent session output |
| `.steps` | Task progress (done / now / todo / fail) |
| `.empty` | Empty states |

## Fonts

| File | Source | License |
| --- | --- | --- |
| `PretendardVariable.subset.woff2` | Pretendard v1.3.9 `PretendardVariable.ttf`, subset to Latin, punctuation and the 2,350 KS X 1001 Hangul syllables with `fontTools.subset` (variable `wght` 45-930 kept) | OFL-1.1 (`fonts/Pretendard-OFL.txt`) |
| `GeistMonoVariable.woff2` | Geist v1.9.2 `GeistMono[wght].woff2` | OFL-1.1 (`fonts/GeistMono-OFL.txt`) |

Syllables outside KS X 1001 fall back to the system font.
