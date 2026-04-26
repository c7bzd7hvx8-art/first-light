/* Runs in <head> before body paint. iOS WebKit sets navigator.standalone for “Add to Home Screen”
   but (display-mode: standalone) often does not match in CSS — hide Install via html.fl-standalone. */
(function () {
  try {
    if (typeof navigator !== 'undefined' && navigator.standalone === true) {
      document.documentElement.classList.add('fl-standalone');
      return;
    }
    if (typeof matchMedia !== 'function') return;
    if (
      matchMedia('(display-mode: standalone)').matches ||
      matchMedia('(display-mode: fullscreen)').matches
    ) {
      document.documentElement.classList.add('fl-standalone');
    }
  } catch (_) { /* private mode / very old browsers */ }
})();
