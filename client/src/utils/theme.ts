import type { Settings } from '../types';

export function applyTheme(theme: Settings['theme']) {
  const dark = theme === 'dark' || (theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.classList.toggle('dark', dark);
  try {
    localStorage.setItem('lanshare.theme', theme);
  } catch {
    /* storage blocked */
  }
}
