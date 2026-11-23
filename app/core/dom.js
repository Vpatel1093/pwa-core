// Tiny DOM helpers. No framework: the whole UI is a few hundred elements
// and is simply rebuilt on each change.

/** A child for h(): a node, text, a list of children, or nothing.
 * @typedef {Node | string | number | null | undefined | false | Child[]} Child */

/**
 * @param {string} tag
 * @param {Record<string, any>} [attrs]
 * @param {...Child} children
 * @returns {HTMLElement}
 */
export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k === 'style') for (const [p, val] of Object.entries(v)) el.style.setProperty(p, val);
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, v);
  }
  append(el, children);
  return el;
}

/** @param {HTMLElement} el @param {Child[]} children */
function append(el, children) {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    if (Array.isArray(c)) append(el, c);
    else el.append(c instanceof Node ? c : String(c));
  }
}

// Tap vs long-press on elements matching `selector` inside `root`.
// Long-press also answers the context-menu gesture (right click, the
// keyboard menu key, Shift+F10), so it isn't touch-only.
/**
 * @param {Element} root
 * @param {string} selector
 * @param {{ tap: (target: Element) => void, longPress: (target: Element) => void, delay?: number }} handlers
 */
export function onPress(root, selector, { tap, longPress, delay = 450 }) {
  /** @type {ReturnType<typeof setTimeout> | null} */
  let timer = null;
  /** @type {{ x: number, y: number } | null} */
  let start = null;
  let fired = false;

  const cancel = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };
  // Pointer, click and context-menu events always target an element.
  /** @param {Event} e */
  const targetOf = (e) => /** @type {Element} */ (e.target).closest(selector);

  root.addEventListener('pointerdown', (ev) => {
    const e = /** @type {PointerEvent} */ (ev);
    const target = targetOf(e);
    if (!target || !root.contains(target) || e.button !== 0) return;
    fired = false;
    start = { x: e.clientX, y: e.clientY };
    cancel();
    timer = setTimeout(() => {
      fired = true;
      timer = null;
      navigator.vibrate?.(10);
      longPress(target);
    }, delay);
  });
  root.addEventListener('pointermove', (ev) => {
    const e = /** @type {PointerEvent} */ (ev);
    if (timer && start && Math.hypot(e.clientX - start.x, e.clientY - start.y) > 10) cancel();
  });
  for (const type of ['pointerup', 'pointercancel', 'pointerleave']) root.addEventListener(type, cancel);
  root.addEventListener('click', (e) => {
    const target = targetOf(e);
    if (!target || !root.contains(target)) return;
    if (fired) {
      fired = false;
      e.preventDefault();
      return;
    }
    tap(target);
  });
  root.addEventListener('contextmenu', (e) => {
    const target = targetOf(e);
    if (!target || !root.contains(target)) return;
    e.preventDefault();
    if (fired) return; // touch long-press already handled it
    cancel();
    longPress(target);
  });
}
