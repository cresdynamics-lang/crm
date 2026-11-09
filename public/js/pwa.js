/**
 * Install Cres OS as an app (phone home screen / desktop) and register the
 * service worker. Shows an "Install Cres OS" button where the browser allows it.
 */
(() => {
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('/sw.js').catch(() => {});
    });
  }

  let deferred = null;
  const standalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone;

  function button() {
    return document.getElementById('install-app-btn');
  }

  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferred = e;
    const b = button();
    if (b && !standalone) b.hidden = false;
  });

  window.addEventListener('appinstalled', () => {
    deferred = null;
    const b = button();
    if (b) b.hidden = true;
    if (typeof CresToast !== 'undefined') CresToast.success('Cres OS installed', { detail: 'Open it from your home screen or apps.' });
  });

  document.addEventListener('click', async (e) => {
    if (!e.target.closest?.('#install-app-btn')) return;
    if (deferred) {
      deferred.prompt();
      await deferred.userChoice.catch(() => null);
      deferred = null;
      button().hidden = true;
    } else if (/iphone|ipad|ipod/i.test(navigator.userAgent) && typeof CresToast !== 'undefined') {
      CresToast.info('Install on iPhone', { detail: 'Tap the Share button in Safari, then "Add to Home Screen".', duration: 10000 });
    }
  });

  // iPhone/iPad never fire beforeinstallprompt: show the button with instructions instead
  document.addEventListener('DOMContentLoaded', () => {
    const b = button();
    if (b && !standalone && /iphone|ipad|ipod/i.test(navigator.userAgent)) b.hidden = false;
  });
})();
