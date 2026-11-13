# Design System — Business Flow

- **Palet Teal–Mint**: `--color-primary: #2ba8a2`, `--color-primary-deep: #187a75` (dipakai untuk teks tombol agar kontras WCAG 2.2 AA >= 4.5:1), `--color-primary-bg: #e8f6f5`, `--color-surface: #eff8f7`, `--color-ink: #203332`, `--color-ink-2: #5c6e6c`, `--color-line: #ddeae8`.
- **Tipografi**: Font sistem (`Inter, ui-sans-serif, system-ui, sans-serif`) tanpa font eksternal. Angka tabel dan KPI memakai `.tnum` (`tabular-nums`).
- **Aksesibilitas**: Target sentuh minimum 44 px (`.field-input`, tombol), fokus terlihat (`:focus-visible` 3px `--color-primary-deep`), skip-link ke `#konten`, dialog konfirmasi in-app `ConfirmDialog` (`role="alertdialog"` + Esc + focus return), dan dukungan `prefers-reduced-motion`.
- **Responsif**: Sidebar drawer di mobile (`< lg`), tabel dibungkus `.table-wrap` dengan `overflow-x: auto` agar bebas overflow horizontal pada layar 360 px.
