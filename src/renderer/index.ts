import { desktopAPI } from '../shared/desktop-api';
import { renderIcons } from './icons';
import { initIPC, init } from './web_remote';

// The macOS window is glass (tauri.conf.json windowEffects); other platforms paint the page.
if (navigator.userAgent.includes('Mac')) document.documentElement.classList.add('glass');

/** Keeps the window as tall as the page, up to the screen; past that the page scrolls. */
function fitWindowToPage(): void {
  new ResizeObserver(() => {
    const height = Math.min(document.body.scrollHeight, window.screen.availHeight);
    if (height !== window.innerHeight) void desktopAPI.setWindowHeight(height);
  }).observe(document.body);
}

document.addEventListener('DOMContentLoaded', () => {
  fitWindowToPage();
  void (async () => {
    try {
      await desktopAPI.start();
      renderIcons();
      initIPC();
      await init();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to start Apple TV Remote.';
      const status = document.getElementById('statusText');
      if (status) {
        status.textContent = message;
        status.style.display = 'block';
      }
      const loading = document.getElementById('initText');
      if (loading) loading.style.display = 'none';
    }
  })();
});
