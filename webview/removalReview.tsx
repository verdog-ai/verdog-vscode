// AGPL-3.0-only with the additional permission in LICENSE-EXCEPTION.
import "./identityPage.css";
import "./removalReview.css";

import { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";

import type { RemovalImpact, RemovalReason } from "../model/editing";
import { entityLabel } from "../model/names";
import type {
  HostToRemovalReview,
  RemovalReviewToHost,
} from "../model/protocol";
import { EntityTree } from "./EntityTree";

type Host = { postMessage: (message: RemovalReviewToHost) => void };
type Review = HostToRemovalReview["review"];
type Section = "selected" | "deleted" | "updated";

declare function acquireVsCodeApi(): Host;

export function sectionOf(impact: RemovalImpact): Section {
  if (impact.effect === "update") return "updated";
  return impact.reasons.some((reason) => reason === "selected" || reason === "contained")
    ? "selected"
    : "deleted";
}

const reasonLabel = (reason: RemovalReason): string => reason.replaceAll("_", " ");

function Impact({ host, impact, index }: { host: Host; impact: RemovalImpact; index: number }) {
  return (
    <li className="impact">
      <a
        className="impact-link"
        href={`#impact-${index}`}
        onClick={(event) => {
          event.preventDefault();
          if (event.detail > 1) return;
          host.postMessage({ index, kind: "reveal" });
        }}
        onDoubleClick={(event) => {
          event.preventDefault();
          host.postMessage({ index, kind: "open" });
        }}
        title={`Reveal ${entityLabel(impact.entity)} ${impact.id}; double-click to open its declaration`}
      >
        <code>{impact.id}</code>
        {impact.reasons.map((reason) => (
          <span className="reason" key={reason}>
            {reasonLabel(reason)}
          </span>
        ))}
      </a>
    </li>
  );
}

function ImpactSection({
  host,
  impacts,
  indexes,
  label,
}: {
  host: Host;
  impacts: RemovalImpact[];
  indexes: ReadonlyMap<RemovalImpact, number>;
  label: string;
}) {
  if (impacts.length === 0) return undefined;
  return (
    <details className="section" open>
      <summary>
        <span>{label}</span>
        <span className="count">{impacts.length}</span>
      </summary>
      <EntityTree
        items={impacts}
        renderItem={(impact) => (
          <Impact
            host={host}
            impact={impact}
            index={indexes.get(impact)!}
            key={`${impact.workflow ?? ""}:${impact.entity}:${impact.id}`}
          />
        )}
      />
    </details>
  );
}

function Imports({ aliases }: { aliases: string[] }) {
  if (aliases.length === 0) return undefined;
  return (
    <details className="section" open>
      <summary>
        <span>Imports to clean up</span>
        <span className="count">{aliases.length}</span>
      </summary>
      <ul className="tree imports">
        {[...aliases].sort().map((alias) => (
          <li className="impact" key={alias}>
            <code>{alias}</code>
          </li>
        ))}
      </ul>
    </details>
  );
}

function Review({ host, review }: { host: Host; review: Review }) {
  const verb = review.reset ? "Reset" : "Delete";
  const indexes = useMemo(
    () => new Map(review.impacts.map((impact, index) => [impact, index])),
    [review.impacts],
  );
  const sections = useMemo(() => {
    const grouped: Record<Section, RemovalImpact[]> = {
      deleted: [],
      selected: [],
      updated: [],
    };
    for (const impact of review.impacts) grouped[sectionOf(impact)].push(impact);
    return grouped;
  }, [review.impacts]);
  const deleted = sections.selected.length + sections.deleted.length;

  return (
    <div className="identity-page">
      <header>
        <h1>
          {verb} {review.subject.label} <code>{review.subject.id}</code>?
        </h1>
        <p className="summary">
          {deleted} {deleted === 1 ? "identity" : "identities"} will be deleted
          {sections.updated.length === 0
            ? undefined
            : ` · ${sections.updated.length} will be updated`}
        </p>
      </header>
      <main aria-label="Deletion impact">
        <ImpactSection
          host={host}
          impacts={sections.selected}
          indexes={indexes}
          label="Selected subtree"
        />
        <ImpactSection
          host={host}
          impacts={sections.deleted}
          indexes={indexes}
          label="Also deleted"
        />
        <ImpactSection
          host={host}
          impacts={sections.updated}
          indexes={indexes}
          label="Will be updated"
        />
        <Imports aliases={review.orphaned} />
      </main>
      <footer>
        <p>
          {review.hasAuthoredCode
            ? "Authored code owned by these identities will move to Trash. "
            : ""}
          {review.reset
            ? "The required ports and pass-through route will be regenerated. "
            : ""}
          Generated files are omitted and will be regenerated.
          {review.orphaned.length === 0
            ? undefined
            : " Unused imports are cleaned up afterward; a dirty checkout may require retrying."}
        </p>
        <div className="actions">
          <button autoFocus onClick={() => host.postMessage({ kind: "cancel" })} type="button">
            Cancel
          </button>
          <button
            className="delete"
            onClick={() => host.postMessage({ kind: "delete" })}
            type="button"
          >
            {review.reset
              ? `Reset to empty ${review.subject.id}`
              : `Delete ${deleted} ${deleted === 1 ? "identity" : "identities"}`}
          </button>
        </div>
      </footer>
    </div>
  );
}

function App({ host }: { host: Host }) {
  const [review, setReview] = useState<Review>();

  useEffect(() => {
    const listen = (event: MessageEvent) => {
      const message = event.data as HostToRemovalReview;
      if (message.kind === "review") setReview(message.review);
    };
    const cancel = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      host.postMessage({ kind: "cancel" });
    };
    window.addEventListener("message", listen);
    window.addEventListener("keydown", cancel);
    host.postMessage({ kind: "ready" });
    return () => {
      window.removeEventListener("message", listen);
      window.removeEventListener("keydown", cancel);
    };
  }, [host]);

  return review === undefined
    ? <p className="loading" role="status">Preparing deletion review…</p>
    : <Review host={host} review={review} />;
}

if (typeof document !== "undefined") {
  const mount = document.getElementById("root");
  if (mount !== null) createRoot(mount).render(<App host={acquireVsCodeApi()} />);
}
