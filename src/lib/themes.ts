/**
 * The theme registry.
 *
 * A theme is a complete palette, not a light/dark mode — Catppuccin Mocha is
 * its own thing, not "dark with different accents". Each entry here has a
 * matching `[data-theme='<id>']` block in index.css supplying eight colour
 * channels; everything else is derived from those.
 *
 * `appearance` drives the second attribute on <html>, which selects the
 * light-or-dark structural values (overlay tint direction, shadow strength,
 * glass highlight). `pairedWith` is the theme to swap to when the user has
 * asked Peekaboo to follow the OS and the OS disagrees with this theme.
 */

export interface ThemeDef {
  id: string;
  label: string;
  /** Grouping label in the picker. */
  family: string;
  appearance: 'light' | 'dark';
  /** Counterpart used when following the system scheme. */
  pairedWith?: string;
}

export const THEMES: ThemeDef[] = [
  { id: 'peek-dark',         label: 'Peekaboo Dark',     family: 'Peekaboo',   appearance: 'dark',  pairedWith: 'peek-light' },
  { id: 'peek-light',        label: 'Peekaboo Light',    family: 'Peekaboo',   appearance: 'light', pairedWith: 'peek-dark' },
  { id: 'catppuccin-mocha',  label: 'Mocha',             family: 'Catppuccin', appearance: 'dark',  pairedWith: 'catppuccin-latte' },
  { id: 'catppuccin-macchiato', label: 'Macchiato',      family: 'Catppuccin', appearance: 'dark',  pairedWith: 'catppuccin-latte' },
  { id: 'catppuccin-latte',  label: 'Latte',             family: 'Catppuccin', appearance: 'light', pairedWith: 'catppuccin-mocha' },
  { id: 'tokyo-night',       label: 'Tokyo Night',       family: 'Tokyo Night', appearance: 'dark', pairedWith: 'tokyo-night-day' },
  { id: 'tokyo-night-day',   label: 'Tokyo Night Day',   family: 'Tokyo Night', appearance: 'light', pairedWith: 'tokyo-night' },
  { id: 'nord',              label: 'Nord',              family: 'Nord',       appearance: 'dark',  pairedWith: 'peek-light' },
  { id: 'gruvbox-dark',      label: 'Gruvbox Dark',      family: 'Gruvbox',    appearance: 'dark',  pairedWith: 'gruvbox-light' },
  { id: 'gruvbox-light',     label: 'Gruvbox Light',     family: 'Gruvbox',    appearance: 'light', pairedWith: 'gruvbox-dark' },
  { id: 'rose-pine',         label: 'Rosé Pine',         family: 'Rosé Pine',  appearance: 'dark',  pairedWith: 'rose-pine-dawn' },
  { id: 'rose-pine-dawn',    label: 'Rosé Pine Dawn',    family: 'Rosé Pine',  appearance: 'light', pairedWith: 'rose-pine' },
  { id: 'solarized-dark',    label: 'Solarized Dark',    family: 'Solarized',  appearance: 'dark',  pairedWith: 'solarized-light' },
  { id: 'solarized-light',   label: 'Solarized Light',   family: 'Solarized',  appearance: 'light', pairedWith: 'solarized-dark' },
];

export const DEFAULT_THEME_ID = 'peek-dark';

export function findTheme(id: string): ThemeDef {
  return THEMES.find((t) => t.id === id) ?? THEMES[0];
}

/** Themes grouped by family, preserving registry order. */
export function themesByFamily(): { family: string; themes: ThemeDef[] }[] {
  const groups: { family: string; themes: ThemeDef[] }[] = [];
  for (const theme of THEMES) {
    const existing = groups.find((g) => g.family === theme.family);
    if (existing) existing.themes.push(theme);
    else groups.push({ family: theme.family, themes: [theme] });
  }
  return groups;
}

/**
 * Accent overrides. 'auto' keeps whatever the theme itself specifies, which is
 * the right default — Catppuccin's mauve is part of Catppuccin.
 */
export const THEME_ACCENTS = ['auto', 'indigo', 'emerald', 'amber', 'rose', 'sky'] as const;
export type ThemeAccent = (typeof THEME_ACCENTS)[number];
