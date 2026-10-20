export const THEME_STORAGE_KEY = 'labellens-theme';

export function resolveTheme(storedTheme, prefersDark = false) {
  if (storedTheme === 'dark' || storedTheme === 'light') return storedTheme;
  return prefersDark ? 'dark' : 'light';
}

export function nextTheme(theme) {
  return theme === 'dark' ? 'light' : 'dark';
}
