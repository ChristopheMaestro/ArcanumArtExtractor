// Collapsible left sidebar.

// Hides the folder tree so the map viewer can use the full page width.
// sidebarControl lets other features (the SEC tile editor) collapse and
// restore it without touching the saved preference.
export let sidebarControl = null;
(function initSidebarToggle() {
  const explorer = document.querySelector('section.explorer');
  const btn = document.getElementById('sidebarToggleBtn');
  if (!explorer || !btn) return;
  const KEY = 'arcanum.sidebarCollapsed';
  const apply = (collapsed) => {
    explorer.classList.toggle('sidebar-collapsed', collapsed);
    document.body.classList.toggle('sidebar-collapsed', collapsed);
    btn.setAttribute('aria-expanded', String(!collapsed));
    btn.textContent = collapsed ? '▶' : '◀';
    btn.title = collapsed ? 'Show the file list' : 'Hide the file list to enlarge the viewer';
    // Canvases listen to their own size (ResizeObserver); this covers the rest.
    window.dispatchEvent(new Event('resize'));
  };
  let collapsed = false;
  try { collapsed = localStorage.getItem(KEY) === '1'; } catch (_) {}
  apply(collapsed);
  sidebarControl = {
    isCollapsed: () => collapsed,
    set: (value, persist) => {
      collapsed = !!value;
      if (persist) { try { localStorage.setItem(KEY, collapsed ? '1' : '0'); } catch (_) {} }
      apply(collapsed);
    }
  };
  btn.addEventListener('click', () => {
    collapsed = !collapsed;
    try { localStorage.setItem(KEY, collapsed ? '1' : '0'); } catch (_) {}
    apply(collapsed);
  });
})();
