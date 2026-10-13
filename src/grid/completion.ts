/** Function-name dropdown shown under the cell editor while typing a formula. */
export class CompletionList {
  readonly el: HTMLDivElement;
  private list: HTMLUListElement;
  private items: string[] = [];
  private index = 0;

  constructor(private onPick: (name: string) => void) {
    this.el = document.createElement("div");
    this.el.className = "adder-completion";
    this.el.hidden = true;
    this.el.setAttribute("data-testid", "formula-completion");
    this.list = document.createElement("ul");
    this.list.setAttribute("role", "listbox");
    this.list.setAttribute("aria-label", "Functions");
    const hint = document.createElement("div");
    hint.className = "adder-completion-hint";
    hint.textContent = "Tab to insert · ↑↓ to choose · Esc to close";
    this.el.append(this.list, hint);
    // Keep focus in the editor when clicking an item.
    this.el.addEventListener("mousedown", (e) => {
      e.preventDefault();
      const li = (e.target as HTMLElement).closest("li");
      if (li?.dataset.name) this.onPick(li.dataset.name);
    });
  }

  get visible(): boolean {
    return !this.el.hidden;
  }

  get current(): string | undefined {
    return this.items[this.index];
  }

  show(items: string[]): void {
    const keep = this.current;
    this.items = items;
    // Keep the highlighted name if it's still in the list.
    this.index = Math.max(0, keep ? items.indexOf(keep) : 0);
    this.render();
    this.el.hidden = false;
  }

  hide(): void {
    this.el.hidden = true;
    this.items = [];
  }

  move(delta: number): void {
    if (!this.items.length) return;
    this.index = (this.index + delta + this.items.length) % this.items.length;
    this.render();
  }

  /** Place under (or, if there's no room, above) the editor rectangle. */
  position(left: number, top: number, bottom: number, containerHeight: number): void {
    const s = this.el.style;
    s.left = `${left}px`;
    const below = containerHeight - bottom;
    if (below < 160 && top > below) {
      s.top = "";
      s.bottom = `${containerHeight - top}px`;
    } else {
      s.bottom = "";
      s.top = `${bottom}px`;
    }
  }

  private render(): void {
    this.list.replaceChildren(
      ...this.items.map((name, i) => {
        const li = document.createElement("li");
        li.setAttribute("role", "option");
        li.dataset.name = name;
        li.textContent = `${name}(`;
        if (i === this.index) {
          li.className = "active";
          li.setAttribute("aria-selected", "true");
        }
        return li;
      }),
    );
    this.list.children[this.index]?.scrollIntoView({ block: "nearest" });
  }
}
