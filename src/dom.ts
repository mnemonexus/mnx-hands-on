/** Small DOM helpers. Everything the student or the source wrote goes in as text, never as HTML. */
type Child = Node | string | null | undefined | false;
type Attrs = Record<string, string | number | boolean | ((event: Event) => void) | null | undefined>;

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs | null = null, ...children: Child[]): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(attrs ?? {})) {
    if (value === null || value === undefined || value === false) continue;
    if (typeof value === 'function') node.addEventListener(name.replace(/^on/, '').toLowerCase(), value);
    else if (name === 'class') node.className = String(value);
    else if (value === true) node.setAttribute(name, '');
    else node.setAttribute(name, String(value));
  }
  for (const child of children) if (child !== null && child !== undefined && child !== false) node.append(child);
  return node;
}

export function button(label: string, variant: 'primary' | 'secondary' | 'ghost' | 'danger', onClick: () => void, extra: Attrs = {}): HTMLButtonElement {
  return h('button', { type: 'button', class: `mnx-button mnx-button--${variant}${extra.small ? ' mnx-button--sm' : ''}`, onclick: onClick, ...extra, small: null }, label);
}

export const empty = (node: Element) => { while (node.firstChild) node.removeChild(node.firstChild); };

/** Grow a textarea to fit what is in it, so a long answer never needs an inner scrollbar. */
export function autosize(area: HTMLTextAreaElement) {
  area.style.height = 'auto';
  area.style.height = `${area.scrollHeight + 2}px`;
}
