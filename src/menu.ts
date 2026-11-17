// Classic desktop-style menu bars: click a title to open its menu; while one is open, hovering another
// title switches to it; choosing an item, clicking elsewhere or Esc closes it. Arrow keys move inside.

function close(bar: HTMLElement) {
  for (const t of bar.querySelectorAll<HTMLElement>(".menu-top")) t.setAttribute("aria-expanded", "false");
}

const items = (pop: Element) => [...pop.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")];

function open(bar: HTMLElement, top: HTMLElement, focusFirst = false) {
  close(bar);
  top.setAttribute("aria-expanded", "true");
  if (focusFirst) items(top.nextElementSibling!)[0]?.focus();
}

export function initMenubars() {
  for (const bar of document.querySelectorAll<HTMLElement>(".menubar")) {
    const tops = [...bar.querySelectorAll<HTMLElement>(".menu-top")];
    const isOpen = () => tops.some((t) => t.getAttribute("aria-expanded") === "true");
    for (const top of tops) {
      top.addEventListener("click", () => (top.getAttribute("aria-expanded") === "true" ? close(bar) : open(bar, top)));
      top.addEventListener("pointerenter", () => {
        if (isOpen() && top.getAttribute("aria-expanded") !== "true") open(bar, top);
      });
      top.addEventListener("keydown", (e) => {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          open(bar, top, true);
        }
      });
      const pop = top.nextElementSibling as HTMLElement;
      pop.addEventListener("click", (e) => {
        const b = (e.target as HTMLElement).closest("button");
        if (b && !b.disabled) {
          close(bar);
          top.focus();
        }
      });
      pop.addEventListener("keydown", (e) => {
        const list = items(pop);
        const i = list.indexOf(document.activeElement as HTMLButtonElement);
        if (e.key === "ArrowDown" || e.key === "ArrowUp") {
          e.preventDefault();
          const n = list.length;
          list[(i + (e.key === "ArrowDown" ? 1 : n - 1) + n) % n]?.focus();
        } else if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
          e.preventDefault();
          const j = tops.indexOf(top);
          const next = tops[(j + (e.key === "ArrowRight" ? 1 : tops.length - 1)) % tops.length];
          open(bar, next, true);
        }
      });
    }
    document.addEventListener("pointerdown", (e) => {
      if (isOpen() && !bar.contains(e.target as Node)) close(bar);
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && isOpen()) {
        const top = tops.find((t) => t.getAttribute("aria-expanded") === "true");
        close(bar);
        top?.focus();
      }
    });
  }
}
