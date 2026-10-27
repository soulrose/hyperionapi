// Themes. "modern" is app.css itself; every other theme is public/themes/<id>.css, loaded on top of it, with its
// rules under html[data-theme="<id>"]. To add a theme: write that file and add a line here.
// (index.html applies the saved theme before the page draws, so keep the storage key and file path in step with it.)
export const THEMES = [
  { id: 'modern', name: 'Modern (default)' },
  { id: 'aero', name: 'Frutiger Aero (Vista)' },
];

const KEY = 'hyperion.theme';

export function currentTheme() {
  try {
    const id = localStorage.getItem(KEY);
    return THEMES.some((t) => t.id === id) ? id : 'modern';
  } catch {
    return 'modern';
  }
}

export function applyTheme(id) {
  const theme = THEMES.some((t) => t.id === id) ? id : 'modern';
  try {
    localStorage.setItem(KEY, theme);
  } catch {
    // storage blocked: the theme still applies until the page closes
  }
  document.documentElement.dataset.theme = theme;
  const link = document.getElementById('themeCss');
  if (theme === 'modern') link.removeAttribute('href');
  else link.setAttribute('href', `themes/${theme}.css`);
}
