// AGPL-3.0-only with the additional permission in LICENSE-EXCEPTION.
import Ajv from "ajv";

import type { TerminationReport, TerminationState } from "../model/termination";
import { terminationRevision } from "../model/termination";
import type { Outcome } from "./cli";

const strings = { type: "array", items: { type: "string" } };
const witness = {
  type: "object", required: ["feature", "expression", "edges", "opposing_edges"],
  properties: { feature: { type: "string" }, expression: { type: "string" }, edges: strings, opposing_edges: strings },
};
const status = { enum: ["certified", "not_certified", "unavailable"] };
const validReport = new Ajv().compile<TerminationReport>({
  type: "object", required: ["projects", "definitions"],
  properties: {
    projects: { type: "object", required: [""], additionalProperties: { type: "string" } },
    definitions: { type: "object", additionalProperties: {
      type: "object", required: ["status", "local_status", "reason", "memory_states", "rules", "dependencies", "edges", "regions"],
      properties: {
        status, local_status: status, reason: { type: "string" },
        memory_states: { type: "integer", minimum: 0 }, rules: { type: "integer", minimum: 0 },
        dependencies: { type: "array", items: {
          type: "object", required: ["scope", "node"],
          properties: { scope: { type: "string" }, node: { type: "string" } },
        } },
        edges: { type: "object", additionalProperties: { enum: ["cleared", "remaining", "unreachable"] } },
        regions: { type: "array", items: {
          type: "object", required: ["id", "nodes", "edges", "witnesses", "cycle"],
          properties: {
            id: { type: "string" }, nodes: strings, edges: strings, witnesses: { type: "array", items: witness },
            cycle: { type: "array", items: {
              type: "object", required: ["node", "values", "edge"],
              properties: { node: { type: "string" }, values: strings, edge: { type: "string" } },
            } },
          },
        } },
      },
    } },
  },
});

/** Validate once at the CLI boundary; all UI consumers receive the typed report. */
export function parseTerminationReport(stdout: string): TerminationReport | undefined {
  try {
    const value: unknown = JSON.parse(stdout);
    return validReport(value) && Object.hasOwn(value.projects, "") ? value : undefined;
  } catch {
    return undefined;
  }
}

/** One cancellable worker for all saved graphs, including nested pinned owners. */
export class TerminationAnalysis {
  private revision = 0;
  private key: string | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private controller: AbortController | undefined;
  private worker: Promise<void> = Promise.resolve();
  private disposed = false;
  private completed: { key: string; state: Extract<TerminationState, { status: "ready" }> } | undefined;
  state: TerminationState | undefined;

  constructor(
    private readonly execute: (signal: AbortSignal) => Promise<Outcome>,
    private readonly publish: (state: TerminationState) => void,
    private readonly debounceMs = 250,
    private readonly timeoutMs = 5_000,
  ) {}

  update(projects: Record<string, string>): TerminationState | undefined {
    if (this.disposed) return this.state;
    const key = terminationRevision({ projects, definitions: {} });
    if (key === this.key) return this.state;
    this.cancel();
    this.key = key;
    if (this.completed?.key === key) {
      this.state = this.completed.state;
      return this.state;
    }
    const revision = this.revision;
    const owners = Object.keys(projects);
    // The caller is already publishing its refreshed snapshot.
    this.state = { status: "checking" };
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.worker = this.worker.then(() => this.run(key, revision, owners));
    }, this.debounceMs);
    return this.state;
  }

  /** Saved files may already differ while the next snapshot is still being read. */
  suspend(): void {
    this.cancel();
    this.key = undefined;
    if (this.state?.status !== "checking") this.setState({ status: "checking" });
  }

  unavailable(reason: string): void {
    this.cancel();
    this.key = undefined;
    this.setState({ status: "unavailable", reason });
  }

  dispose(): void {
    this.disposed = true;
    this.cancel();
  }

  private cancel(): void {
    ++this.revision;
    clearTimeout(this.timer);
    this.timer = undefined;
    this.controller?.abort();
  }

  private setState(state: TerminationState): void {
    if (this.disposed) return;
    this.state = state;
    this.publish(state);
  }

  private async run(key: string, revision: number, owners: readonly string[]): Promise<void> {
    if (this.disposed || revision !== this.revision) return;
    const controller = new AbortController();
    this.controller = controller;
    const deadline = setTimeout(() => controller.abort(), this.timeoutMs);
    let state: TerminationState;
    try {
      const result = await this.execute(controller.signal);
      const report = result.code === 0 ? parseTerminationReport(result.stdout) : undefined;
      state = controller.signal.aborted
        ? { status: "unavailable", reason: "Analysis exceeded its five-second time limit." }
        : report !== undefined && terminationRevision(report) === key
          ? { status: "ready", report }
          : { status: "unavailable", reason: result.code !== 0
              ? result.stderr.trim() || "Analysis failed. Check the Verdog service connection, then refresh the graph."
              : report === undefined
                ? "The Verdog analysis service returned an unsupported report."
                : owners.some((owner) => !Object.hasOwn(report.projects, owner))
                  ? "Some pinned graphs could not be analyzed. Check their schema, package identity, and dependency chain."
                  : "The saved graphs changed while termination was being analyzed." };
    } catch (error) {
      state = { status: "unavailable", reason: String(error) };
    } finally {
      clearTimeout(deadline);
      this.controller = undefined;
    }
    if (!this.disposed && revision === this.revision) {
      if (state.status === "ready") this.completed = { key, state };
      else this.key = undefined;
      this.setState(state);
    }
  }
}
