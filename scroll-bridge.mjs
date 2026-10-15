// Runs inside each isolated preview; only its review parent can exchange positions.
export function scrollBridge(appOrigin) {
  let applying = false;
  const route = () => location.pathname + location.search;
  function selector(element) {
    if (element === document.scrollingElement) return ':root';
    if (element.id) return '#' + CSS.escape(element.id);
    const parts = [];
    while (element && element !== document.documentElement) {
      parts.unshift(`${element.localName}:nth-child(${Array.from(element.parentElement.children).indexOf(element) + 1})`);
      element = element.parentElement;
    }
    return 'html > ' + parts.join(' > ');
  }
  const scrollers = () => [document.scrollingElement, ...document.querySelectorAll('body *')].filter(element =>
    element && (element === document.scrollingElement || /auto|scroll/.test(getComputedStyle(element).overflow + getComputedStyle(element).overflowY + getComputedStyle(element).overflowX)));
  function capture() {
    const positions = scrollers().map(element => ({selector: selector(element), x: element.scrollLeft, y: element.scrollTop}));
    const rows = Array.from(document.querySelectorAll('tbody tr'));
    const row = rows.find(element => {
      const rect = element.getBoundingClientRect();
      return rect.height > 0 && rect.top >= 0 && rect.top < innerHeight && rect.right > 0 && rect.left < innerWidth;
    });
    return {route: route(), positions, anchor: row ? {
      table: selector(row.closest('table')),
      key: row.cells[0]?.textContent.trim(),
      top: row.getBoundingClientRect().top,
    } : null};
  }
  function restore(snapshot) {
    if (snapshot?.route !== route() || !Array.isArray(snapshot.positions)) return;
    applying = true;
    for (const position of snapshot.positions.slice(0, 200)) {
      if (typeof position.selector !== 'string' || !Number.isFinite(position.x) || !Number.isFinite(position.y)) continue;
      let element;
      try { element = position.selector === ':root' ? document.scrollingElement : document.querySelector(position.selector); } catch { continue; }
      element?.scrollTo({left: position.x, top: position.y, behavior: 'instant'});
    }
    const anchor = snapshot.anchor;
    if (anchor && typeof anchor.table === 'string' && typeof anchor.key === 'string' && Number.isFinite(anchor.top)) {
      let table;
      try { table = document.querySelector(anchor.table); } catch {}
      const matches = Array.from(table?.querySelectorAll('tbody tr') || []).filter(row => row.cells[0]?.textContent.trim() === anchor.key);
      if (matches.length === 1) {
        const row = matches[0];
        let container = row.parentElement;
        while (container && container !== document.scrollingElement && !(container.scrollHeight > container.clientHeight && /auto|scroll/.test(getComputedStyle(container).overflowY))) container = container.parentElement;
        container ||= document.scrollingElement;
        container.scrollTo({left: container.scrollLeft, top: container.scrollTop + row.getBoundingClientRect().top - anchor.top, behavior: 'instant'});
      }
    }
    requestAnimationFrame(() => { applying = false; });
  }
  addEventListener('scroll', () => {
    if (!applying) parent.postMessage({type: 'review:scroll', snapshot: capture()}, appOrigin);
  }, true);
  addEventListener('message', event => {
    if (event.source === parent && event.origin === appOrigin && event.data?.type === 'review:scroll') restore(event.data.snapshot);
  });
}
