// Loader/launcher for embedding TagMyPhoto Express on another site (e.g. a
// team's Presto Sports page), so the app runs same-origin with that site's
// own pages and its roster importer can fetch() them without hitting CORS.
//
// Usage: add a single tag to the embedding page:
//   <script src="https://express.tagmy.photo/embed.js"></script>
//
// This injects a small launch button; clicking it mounts the full app
// inside a shadow root (so its CSS can't collide with the host page's, in
// either direction) as a full-viewport overlay. Closing hides the overlay
// rather than tearing it down, so re-opening is instant and app.js's
// global listeners are only ever registered once per page visit.
(function () {
  // Captured now, synchronously, since document.currentScript is only valid
  // during the script's own initial (non-async) execution — it's how the
  // launcher finds where in the page to insert itself.
  const scriptEl = document.currentScript;
  const BASE = scriptEl
    ? new URL('.', scriptEl.src).href
    : 'https://express.tagmy.photo/';
  // The app's own asset host doesn't send cache-busting headers, and once
  // mounted, the app stays mounted for the rest of the page's lifetime
  // (Launch just re-shows it — see boot() below) — so without this, a
  // browser that already cached an older app.js/index.html/style.css could
  // silently keep running stale code indefinitely, even across page
  // reloads. Fetching everything with a fresh per-load query string forces
  // the browser to treat it as a new resource every time.
  const CACHE_BUST = Date.now();
  const withCacheBust = path => `${BASE}${path}?v=${CACHE_BUST}`;

  // Returns { button, statusLabel } — statusLabel is the small top line
  // ("Launch" / "Loading…" / "Failed — retry"); the logo + name below it
  // never changes, so the button keeps looking like a normal, permanent
  // piece of the page rather than a transient overlay control.
  function createLauncher() {
    const host = document.createElement('span');
    host.style.cssText = 'display:inline-block;';
    const shadow = host.attachShadow({ mode: 'open' });
    const btn = document.createElement('button');
    btn.style.cssText = `
      display:flex; flex-direction:column; align-items:center; gap:3px;
      font-family:-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      padding: 10px 26px; border-radius: 14px; border: none;
      background: #0d3f63; color: #fff; cursor: pointer;
      box-shadow: 0 2px 10px rgba(0, 0, 0, .25);
    `;
    const statusLabel = document.createElement('span');
    statusLabel.textContent = 'Launch';
    statusLabel.style.cssText = `
      font-size: 11px; font-weight: 600; letter-spacing: .06em;
      text-transform: uppercase; opacity: .75;
    `;
    const nameLabel = document.createElement('span');
    nameLabel.textContent = '\u{1F4F7} TagMyPhoto'; // avoid relying on the host page declaring UTF-8
    nameLabel.style.cssText = 'font-size: 16px; font-weight: 700; line-height: 1.2;';
    btn.append(statusLabel, nameLabel);
    shadow.appendChild(btn);

    // Insert right where the <script> tag itself sits (its parent already
    // exists at this point, even before the rest of the page has loaded),
    // so the button appears inline in the page's own content flow instead
    // of floating in a corner.
    if (scriptEl && scriptEl.parentNode) {
      scriptEl.parentNode.insertBefore(host, scriptEl.nextSibling);
    } else {
      document.body.appendChild(host);
    }

    return { button: btn, statusLabel };
  }

  async function mountApp() {
    const host = document.createElement('div');
    host.style.cssText = 'position:fixed; inset:0; z-index:2147483646; background:#fff;';
    document.body.appendChild(host);
    // If anything below throws (a blocked fetch, an untrusted cert, a
    // missing file), this already-appended full-viewport div would
    // otherwise be left stuck on screen — a "white screen" hiding whatever
    // error state the launch button ends up in. mountAppInner does the
    // real work; any failure here removes the stuck host before rethrowing.
    try {
      return await mountAppInner(host);
    } catch (err) {
      host.remove();
      throw err;
    }
  }

  async function mountAppInner(host) {
    const shadow = host.attachShadow({ mode: 'open' });

    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = withCacheBust('style.css');
    shadow.appendChild(link);

    const res = await fetch(withCacheBust('index.html'));
    if (!res.ok) throw new Error(`Failed to load app (HTTP ${res.status})`);
    const doc = new DOMParser().parseFromString(await res.text(), 'text/html');
    // index.html's own trailing <script type="module" src="app.js"> is
    // parsed inert (DOMParser-created script elements never execute) — drop
    // it anyway since we load app.js ourselves below with the right root.
    doc.querySelectorAll('script').forEach(s => s.remove());
    // Relative asset references (e.g. the logo) resolve against the host
    // page's origin once injected there, not express.tagmy.photo — rewrite
    // them to absolute URLs first.
    doc.body.querySelectorAll('img[src]').forEach(img => {
      img.setAttribute('src', new URL(img.getAttribute('src'), BASE).href);
    });

    // style.css styles the real <body> element (font, color, background),
    // but we're copying index.html's body *contents* into a <div>, not a
    // <body> — so those rules wouldn't otherwise match anything here.
    // Duplicating the same three declarations onto the wrapper keeps it
    // looking right; var(--bg-page) etc. still resolve via :host above.
    const wrapper = document.createElement('div');
    wrapper.id = 'tmpx-embed-root';
    wrapper.style.cssText = `
      width:100%; height:100%; overflow:auto; margin:0;
      font-family:-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      color:var(--text-primary); background:var(--bg-page);
    `;
    wrapper.innerHTML = doc.body.innerHTML;
    shadow.appendChild(wrapper);

    // app.js reads these to know where to query for its own elements and
    // where to put the dark-mode attribute, instead of the real document.
    window.__TMPX_ROOT__ = shadow;
    window.__TMPX_THEME_ROOT__ = wrapper;
    if (localStorage.getItem('darkMode') === '1') wrapper.setAttribute('data-theme', 'dark');

    const closeBtn = document.createElement('button');
    closeBtn.textContent = '\u2715';
    closeBtn.setAttribute('aria-label', 'Close TagMyPhoto');
    // Reuses the app's own header-button classes (from style.css, loaded
    // above) so it matches the "?" and settings buttons it sits next to.
    closeBtn.className = 'btn-manage topbar-settings-btn';
    // A real flex child of .topbar, appended last, so the existing buttons
    // naturally shift left to make room for it instead of it floating on
    // top of them. Modals (.modal-overlay, z-index:1000) are siblings of
    // #app that cover the full viewport including the header, so without
    // its own stacking context this button would end up trapped underneath
    // an open modal — position:relative plus a higher z-index keeps it
    // above that overlay while still fully participating in the header's
    // flex layout.
    closeBtn.style.cssText = 'position:relative; z-index:1001; font-size:20px;';
    closeBtn.addEventListener('click', () => { host.style.display = 'none'; });
    const topbar = wrapper.querySelector('.topbar');
    if (topbar) topbar.appendChild(closeBtn);
    else shadow.appendChild(closeBtn); // fallback if index.html's header markup ever changes

    await new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.type = 'module'; // app.js uses `import` for the exiv2 wasm module
      script.src = withCacheBust('app.js');
      script.addEventListener('load', resolve);
      script.addEventListener('error', () => reject(new Error('Failed to load app.js')));
      document.body.appendChild(script);
    });

    return host;
  }

  function boot() {
    const { button: launchBtn, statusLabel } = createLauncher();
    let host = null;
    let mounting = false;

    launchBtn.addEventListener('click', async () => {
      if (mounting) return;
      if (host) { host.style.display = ''; return; }
      mounting = true;
      launchBtn.disabled = true;
      statusLabel.textContent = 'Loading\u2026';
      try {
        host = await mountApp();
        statusLabel.textContent = 'Launch';
      } catch (err) {
        console.error('[TagMyPhoto embed]', err);
        statusLabel.textContent = 'Failed \u2014 retry';
      } finally {
        launchBtn.disabled = false;
        mounting = false;
      }
    });
  }

  // The launcher inserts itself relative to the script tag's own (already
  // existing) parent, so it doesn't need to wait for the rest of the page.
  boot();
})();
