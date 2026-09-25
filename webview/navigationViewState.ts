// AGPL-3.0-only with the additional permission in LICENSE-EXCEPTION.
type ViewState = {
  disclosures: Map<string, boolean>;
  focus?: string;
  scrollTop: number;
};

/** Presentation only: the host still owns navigation history and entity targets. */
export class NavigationViews {
  private readonly views = new Map<string, ViewState>();

  at(route: string): ViewState {
    let view = this.views.get(route);
    if (view === undefined) {
      view = { disclosures: new Map(), scrollTop: 0 };
      this.views.set(route, view);
    }
    return view;
  }

  retain(routes: readonly string[]): void {
    const retained = new Set(routes);
    for (const route of this.views.keys()) {
      if (!retained.has(route)) this.views.delete(route);
    }
  }

  restoreDisclosures(route: string, main: HTMLElement): void {
    const view = this.at(route);
    for (const details of main.querySelectorAll<HTMLDetailsElement>("details[data-disclosure]")) {
      const open = view.disclosures.get(details.dataset.disclosure!);
      if (open !== undefined) details.open = open;
    }
  }

  restore(route: string, main: HTMLElement): void {
    const view = this.at(route);
    this.restoreDisclosures(route, main);
    main.scrollTop = view.scrollTop;
    const focused = [...main.querySelectorAll<HTMLElement>("[data-navigation-focus]")]
      .find((element) => element.dataset.navigationFocus === view.focus && element.getClientRects().length > 0);
    (focused ?? main).focus({ preventScroll: true });
  }
}
