/** AGPL-3.0-only with the additional permission in LICENSE-EXCEPTION. */

import type {
  NavigationPropertyEdit,
  PropertyRequest,
  PropertyResult,
} from '../model/protocol';

/** One pending save per panel; navigation does not cancel an already-started save. */
export class PropertyRequests {
  private nextId = 0;
  private route: string | undefined;
  private visit = 0;
  private pending: {request: PropertyRequest; visit: number} | undefined;

  navigate(route: string): void {
    if (this.route !== route) {
      ++this.visit;
    }
    this.route = route;
  }

  submit(edit: NavigationPropertyEdit): PropertyRequest | undefined {
    if (this.pending !== undefined || this.route === undefined) {
      return undefined;
    }
    const request: PropertyRequest = {
      edit,
      kind: 'property',
      requestId: ++this.nextId,
      route: this.route,
    };
    this.pending = {request, visit: this.visit};
    return request;
  }

  settle(
    result: PropertyResult,
  ): {request: PropertyRequest; current: boolean} | undefined {
    const pending = this.pending;
    if (
      pending === undefined ||
      pending.request.requestId !== result.requestId ||
      pending.request.route !== result.route
    ) {
      return undefined;
    }
    this.pending = undefined;
    return {request: pending.request, current: pending.visit === this.visit};
  }
}
