export const THEME_STORAGE_KEY = 'mb.theme';

/** Inline, pre-hydration script: applies a stored explicit theme before first paint to avoid a flash. */
export const THEME_INIT_SCRIPT = `try{var t=localStorage.getItem('${THEME_STORAGE_KEY}');if(t==='light'||t==='dark')document.documentElement.setAttribute('data-theme',t)}catch(e){}`;
