export type MenuItem = { label: string; run: () => void; danger?: boolean } | "separator";

let current: (() => void) | null = null;

/** A context menu at viewport point (x, y). Closes on pick, Escape, scroll, or a click elsewhere. */
export function showMenu(x: number, y: number, items: MenuItem[]): void {
  current?.();
  const menu = document.createElement("div");
  menu.className = "adder-menu";
  menu.setAttribute("role", "menu");
  menu.dataset.testid = "context-menu";
  const buttons: HTMLButtonElement[] = [];
  for (const item of items) {
    if (item === "separator") {
      menu.append(Object.assign(document.createElement("div"), { className: "adder-menu-sep" }));
      continue;
    }
    const b = document.createElement("button");
    b.type = "button";
    b.setAttribute("role", "menuitem");
    b.textContent = item.label;
    if (item.danger) b.classList.add("danger");
    b.addEventListener("click", () => {
      close();
      item.run();
    });
    buttons.push(b);
    menu.append(b);
  }
  document.body.append(menu);
  // Keep the menu on screen.
  const r = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(4, Math.min(x, innerWidth - r.width - 4))}px`;
  menu.style.top = `${Math.max(4, Math.min(y, innerHeight - r.height - 4))}px`;
  buttons[0]?.focus();

  const onDown = (e: Event) => !menu.contains(e.target as Node) && close();
  const onKey = (e: KeyboardEvent) => {
    const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === "Escape") close();
    else if (e.key === "ArrowDown" || e.key === "ArrowUp") buttons[(at + (e.key === "ArrowDown" ? 1 : buttons.length - 1)) % buttons.length]?.focus();
    else return;
    e.preventDefault();
  };
  const close = () => {
    current = null;
    menu.remove();
    window.removeEventListener("mousedown", onDown, true);
    window.removeEventListener("keydown", onKey, true);
    window.removeEventListener("blur", close);
    window.removeEventListener("wheel", close, true);
  };
  window.addEventListener("mousedown", onDown, true);
  window.addEventListener("keydown", onKey, true);
  window.addEventListener("blur", close);
  window.addEventListener("wheel", close, true);
  current = close;
}
