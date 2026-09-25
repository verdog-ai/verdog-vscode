// AGPL-3.0-only with the additional permission in LICENSE-EXCEPTION.
/** Discovery sidebar and the full-editor scholarly record for a published workflow. */

import "./catalogue.css";

import DOMPurify from "dompurify";
import { graphviz, type GraphvizRenderer } from "d3-graphviz";
import MarkdownIt from "markdown-it";
import { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";

import type {
  CatalogueDetail,
  CatalogueDocumentation,
  CatalogueListing,
  CataloguePreview,
  CatalogueRecord,
  CatalogueSummary,
} from "../model/catalogue";
import type { CatalogueToHost, HostToCatalogue } from "../model/protocol";
import { inspectionFooterText } from "./catalogueInspection";
import { documentationHref } from "./catalogueLinks";
import { demoteDocumentationHeadings } from "./catalogueMarkdown";

type Host = { postMessage: (message: CatalogueToHost) => void };
declare function acquireVsCodeApi(): Host;
const host: Host = acquireVsCodeApi();

type Scope = "all" | "mine" | "public" | "restricted";
const SCOPES: { label: string; value: Scope }[] = [
  { label: "All records", value: "all" },
  { label: "Public", value: "public" },
  { label: "Restricted", value: "restricted" },
  { label: "Published by me", value: "mine" },
];

const date = (value: string): string => new Intl.DateTimeFormat(undefined, {
  day: "numeric",
  month: "short",
  year: "numeric",
}).format(new Date(value));

const exactReference = (entry: CatalogueSummary): string =>
  `${entry.repository}@${entry.commit} ${entry.workflow_id}`;

function locallyVisible(
  entry: CatalogueSummary,
  scope: Scope,
  login: string | undefined,
): boolean {
  if (scope === "all") return true;
  if (scope === "public" || scope === "restricted") return entry.visibility === scope;
  // `published_by_me` is authoritative. The owner fallback keeps one preceding CLI usable.
  return entry.published_by_me || (login !== undefined && entry.repository.startsWith(`${login}/`));
}

function CatalogueRow({ entry }: { entry: CatalogueSummary }) {
  return (
    <li className="catalogue-row">
      <button
        aria-label={`Open catalogue record for ${entry.display_name}`}
        className="catalogue-row-button"
        onClick={() => host.postMessage({ entry: entry.id, kind: "open-record" })}
        type="button"
      >
        <span className="row-heading">
          <span className="row-title">{entry.display_name}</span>
          <span className={`visibility-mark ${entry.visibility}`}>
            {entry.visibility === "public" ? "Public" : "Restricted"}
          </span>
        </span>
        <span className="row-address">
          {entry.repository} · <code>{entry.workflow_id}</code>
        </span>
        <span className={`row-abstract${entry.description === null ? " absent" : ""}`}>
          {entry.description ?? "No abstract supplied."}
        </span>
        <span className="row-citation">
          {date(entry.published_at)} · <code>{entry.commit.slice(0, 10)}</code>
          {entry.release_count > 1 ? ` · ${entry.release_count} releases` : ""}
          {entry.dependency_count > 0 ? ` · ${entry.dependency_count} dependencies` : ""}
        </span>
      </button>
    </li>
  );
}

function CatalogueSidebar({ initial }: { initial: CatalogueListing }) {
  const [listing, setListing] = useState(initial);
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState<Scope>("all");
  const first = useRef(true);

  useEffect(() => {
    const listen = (event: MessageEvent) => {
      const message = event.data as HostToCatalogue;
      if (message.kind === "listing") setListing(message.listing);
    };
    window.addEventListener("message", listen);
    return () => window.removeEventListener("message", listen);
  }, []);

  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    const timeout = window.setTimeout(() => {
      host.postMessage({ kind: "search", query, visibility: scope });
    }, 250);
    return () => window.clearTimeout(timeout);
  }, [query, scope]);

  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return listing.entries.filter((entry) =>
      locallyVisible(entry, scope, listing.login) && (
        needle === "" ||
        `${entry.display_name} ${entry.repository} ${entry.workflow_id} ${entry.description ?? ""}`
          .toLowerCase().includes(needle)
      )
    );
  }, [listing, query, scope]);

  return (
    <aside className="catalogue-sidebar" aria-label="Published workflow catalogue">
      <header className="sidebar-header">
        <p className="sidebar-kicker">Workflow index</p>
        <label className="visually-hidden" htmlFor="catalogue-search">Search catalogue</label>
        <input
          id="catalogue-search"
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search records"
          type="search"
          value={query}
        />
        <div className="filter-line">
          <label className="visually-hidden" htmlFor="catalogue-scope">Visibility</label>
          <select
            id="catalogue-scope"
            onChange={(event) => setScope(event.target.value as Scope)}
            value={scope}
          >
            {SCOPES.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
          <button
            className="icon-button"
            onClick={() => host.postMessage({ kind: "refresh" })}
            title="Refresh catalogue"
            type="button"
          >
            ↻<span className="visually-hidden">Refresh catalogue</span>
          </button>
        </div>
      </header>
      <div aria-live="polite" className="sidebar-status">
        {listing.state === "loading" ? "Consulting the catalogue…" : undefined}
        {listing.state === "unauthenticated" ? "Sign in with `verdog login` to consult the catalogue." : undefined}
        {listing.state === "unavailable" ? listing.detail ?? "The catalogue is unavailable." : undefined}
      </div>
      {listing.state !== "loading" && shown.length === 0 ? (
        <p className="empty-note">
          {listing.entries.length === 0 ? "No workflow records are available." : "No records match this query."}
        </p>
      ) : (
        <ol className="catalogue-index">
          {shown.map((entry) => <CatalogueRow entry={entry} key={entry.id} />)}
        </ol>
      )}
      {listing.next_cursor !== undefined ? (
        <button
          className="load-more"
          onClick={() => host.postMessage({ cursor: listing.next_cursor!, kind: "load-more" })}
          type="button"
        >
          Load further records
        </button>
      ) : undefined}
    </aside>
  );
}

function quote(value: string): string {
  return JSON.stringify(value);
}

function previewDot(preview: CataloguePreview): string {
  const lines = [
    "digraph catalogue {",
    'graph [bgcolor="transparent", rankdir="TB", ranksep=0.7, nodesep=0.7, splines="spline", outputorder="edgesfirst"];',
    'node [shape="box", style="rounded", margin="0.18,0.10", fontname="serif", fontsize=12, penwidth=1];',
    'edge [penwidth=1, arrowsize=0.65];',
  ];
  for (const node of preview.nodes) {
    lines.push(`${quote(node.id)} [label=${quote(`${node.kind.replaceAll("_", " ")}\n${node.name}`)}];`);
  }
  for (const edge of preview.edges) {
    lines.push(`${quote(edge.source)} -> ${quote(edge.target)} [label=${quote(edge.name)}];`);
  }
  lines.push("}");
  return lines.join("\n");
}

function WorkflowFigure({ preview }: { preview: CataloguePreview }) {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const container = ref.current;
    if (container === null || preview.nodes.length === 0) return;
    const renderer: GraphvizRenderer = graphviz(container, {
      fit: true,
      height: null,
      useWorker: false,
      width: null,
      zoom: false,
    }).fade(false).tweenPaths(false).tweenShapes(false)
      .onerror((error) => console.error("Catalogue graph layout failed", error));
    renderer.dot(previewDot(preview)).render(() => {
      const svg = container.querySelector("svg");
      svg?.setAttribute("preserveAspectRatio", "xMidYMid meet");
      if (svg !== null) {
        svg.style.height = "auto";
        svg.style.maxHeight = "34rem";
        svg.style.width = "100%";
      }
    });
    return () => { renderer.destroy(); };
  }, [preview]);
  if (preview.nodes.length === 0) return <p className="section-note">No nodes were published for this figure.</p>;
  return (
    <>
      <figure className="workflow-figure">
        <div aria-hidden="true" className="graph-plate" ref={ref} />
        <figcaption>
          <strong>Figure 1.</strong> Published workflow structure for this exact release. This is the publisher&apos;s catalogue description; source comparison occurs during inspection.
        </figcaption>
      </figure>
      <details className="structure-outline">
        <summary>Textual structure</summary>
        <p>{preview.nodes.length} nodes and {preview.edges.length} transitions.</p>
        <ul>
          {preview.nodes.map((node) => <li key={node.id}><code>{node.id}</code> — {node.kind.replaceAll("_", " ")}: {node.name}</li>)}
        </ul>
      </details>
    </>
  );
}

function renderDocumentation(
  documentation: Extract<CatalogueDocumentation, { state: "ready" }>,
  detail: CatalogueDetail,
): string {
  const markdown = new MarkdownIt({ breaks: false, html: false, linkify: false, typographer: false });
  markdown.core.ruler.after("block", "catalogue-heading-levels", (state) =>
    demoteDocumentationHeadings(state.tokens)
  );
  markdown.renderer.rules.image = (tokens, index) => {
    const alt = markdown.utils.escapeHtml(tokens[index].content || "image");
    return `<span class="omitted-image">[Image omitted: ${alt}]</span>`;
  };
  markdown.renderer.rules.link_open = (tokens, index, options, _environment, self) => {
    const href = tokens[index].attrGet("href") ?? "";
    const resolved = documentationHref(href, detail.repository, detail.commit, documentation.path);
    if (resolved === undefined) tokens[index].attrSet("href", "#unsafe-link");
    else {
      tokens[index].attrSet("href", resolved.startsWith("#") ? resolved : "#open-link");
      if (!resolved.startsWith("#")) tokens[index].attrSet("data-verdog-href", resolved);
    }
    return self.renderToken(tokens, index, options);
  };
  return DOMPurify.sanitize(markdown.render(documentation.markdown), {
    ADD_ATTR: ["data-verdog-href"],
    FORBID_TAGS: ["audio", "embed", "form", "iframe", "img", "object", "script", "style", "video"],
  });
}

function Documentation({ detail, documentation }: {
  detail: CatalogueDetail;
  documentation: CatalogueDocumentation;
}) {
  const html = useMemo(
    () => documentation.state === "ready" ? renderDocumentation(documentation, detail) : undefined,
    [detail, documentation],
  );
  if (documentation.state === "loading") return <p className="section-note">Retrieving the exact README without checking out a worktree…</p>;
  if (documentation.state !== "ready") {
    return (
      <div className={`documentation-state ${documentation.state}`}>
        <p>{documentation.detail}</p>
        <button onClick={() => host.postMessage({ kind: "retry-readme" })} type="button">Retry documentation</button>
      </div>
    );
  }
  return (
    <div
      className="documentation markdown-body"
      dangerouslySetInnerHTML={{ __html: html ?? "" }}
      onClick={(event) => {
        const target = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>("a") : null;
        const href = target?.dataset.verdogHref;
        if (href !== undefined) {
          event.preventDefault();
          host.postMessage({ href, kind: "open-external" });
        }
      }}
    />
  );
}

function StageRail({ record }: { record: CatalogueRecord }) {
  const inspection = record.inspection.state;
  const inspectState = inspection === "idle" ? "available" : inspection;
  const importState = inspection === "ready" ? "available" : "pending";
  return (
    <ol aria-label="Catalogue workflow stages" className="stage-rail">
      <li className="complete"><span>1</span><strong>Metadata</strong><small>complete</small></li>
      <li className={inspection === "ready" ? "complete" : inspection}><span>2</span><strong>Inspect</strong><small>{inspectState}</small></li>
      <li className={importState}><span>3</span><strong>Import</strong><small>{importState}</small></li>
    </ol>
  );
}

function Metadata({ detail }: { detail: CatalogueDetail }) {
  return (
    <dl className="metadata">
      <div><dt>Repository</dt><dd>{detail.repository}</dd></div>
      <div><dt>Workflow</dt><dd><code>{detail.workflow_id}</code></dd></div>
      <div><dt>Revision</dt><dd><code title={detail.commit}>{detail.commit}</code></dd></div>
      <div><dt>Package</dt><dd><code>{detail.package ?? "unavailable"}</code></dd></div>
      <div><dt>Visibility</dt><dd>{detail.visibility === "public" ? "Public" : "Restricted"}</dd></div>
      <div><dt>Published</dt><dd>{date(detail.published_at)}</dd></div>
      {detail.updated_at ? <div><dt>Metadata updated</dt><dd>{date(detail.updated_at)}</dd></div> : undefined}
    </dl>
  );
}

function RecordActions({ record }: { record: CatalogueRecord }) {
  const inspection = record.inspection;
  return (
    <div className="record-actions">
      <button onClick={() => host.postMessage({ kind: "copy-reference" })} type="button">Copy reference</button>
      {inspection.state === "incomplete" || inspection.state === "mismatch" ? (
        <>
          <button onClick={() => host.postMessage({ kind: "show-output" })} type="button">Show output</button>
          {inspection.folder ? (
            <button onClick={() => host.postMessage({ kind: "open-source" })} type="button">Open source anyway</button>
          ) : undefined}
        </>
      ) : undefined}
      {inspection.state === "ready" ? (
        <>
          <button onClick={() => host.postMessage({ kind: "open-source" })} type="button">Open inspected source</button>
          <button className="primary" onClick={() => host.postMessage({ kind: "import" })} type="button">Import into project…</button>
        </>
      ) : (
        <button
          className="primary"
          disabled={inspection.state === "running"}
          onClick={() => host.postMessage({ kind: "inspect" })}
          type="button"
        >
          {inspection.state === "running" ? "Inspecting…" : inspection.state === "idle" ? "Inspect release" : "Retry inspection"}
        </button>
      )}
    </div>
  );
}

function CatalogueRecordPage({ initial }: { initial: CatalogueRecord }) {
  const [record, setRecord] = useState(initial);
  useEffect(() => {
    const listen = (event: MessageEvent) => {
      const message = event.data as HostToCatalogue;
      if (message.kind === "record") setRecord(message.record);
    };
    window.addEventListener("message", listen);
    return () => window.removeEventListener("message", listen);
  }, []);
  if (record.state === "loading") return <main className="record-loading">Retrieving the exact catalogue record…</main>;
  if (record.detail === undefined) return <main className="record-loading error">{record.message ?? "This record is unavailable."}</main>;
  const detail = record.detail;
  const environment = detail.environment;
  return (
    <div className="record-page">
      <header className="record-header">
        <div className="record-heading">
          <p className="record-kicker">Workflow record</p>
          <h1>{detail.display_name}</h1>
          <p className="record-address"><code>{detail.workflow_id}</code> · {detail.repository}</p>
        </div>
        <span className={`visibility-label ${detail.visibility}`}>
          {detail.visibility === "public" ? "Public record" : "Restricted record"}
        </span>
      </header>
      <main className="record-main">
        <StageRail record={record} />
        {record.message ? <p aria-live="polite" className="record-message">{record.message}</p> : undefined}
        {record.inspection.state !== "idle" && record.inspection.state !== "ready" ? (
          <p aria-live="polite" className={`inspection-note ${record.inspection.state}`}>
            {record.inspection.detail}
          </p>
        ) : undefined}
        <div className="record-grid">
          <article>
            <section aria-labelledby="abstract-heading" className="record-section abstract">
              <p className="section-number">Abstract</p>
              <h2 id="abstract-heading">Purpose and contribution</h2>
              <p>{detail.description ?? "No abstract was supplied for this release."}</p>
            </section>
            <section aria-labelledby="workflow-heading" className="record-section">
              <p className="section-number">1</p>
              <h2 id="workflow-heading">Workflow structure</h2>
              {detail.preview === undefined
                ? <p className="section-note">A graph preview is unavailable for this legacy record.</p>
                : <WorkflowFigure preview={detail.preview} />}
            </section>
            <section aria-labelledby="interface-heading" className="record-section">
              <p className="section-number">2</p>
              <h2 id="interface-heading">Interface and environment</h2>
              <table>
                <tbody>
                  <tr><th scope="row">Workflow identifier</th><td><code>{detail.workflow_id}</code></td></tr>
                  <tr><th scope="row">Python package</th><td><code>{detail.package ?? "unavailable"}</code></td></tr>
                  <tr><th scope="row">Python constraint</th><td>{environment?.python ?? "Not recorded"}</td></tr>
                  <tr><th scope="row">Schema version</th><td>{environment?.schema_version ?? "Not recorded"}</td></tr>
                  {detail.preview === undefined ? undefined : Object.entries(detail.preview.ports).map(([port, node]) => (
                    <tr key={port}><th scope="row">{port} port</th><td><code>{node}</code></td></tr>
                  ))}
                </tbody>
              </table>
              {detail.preview && detail.preview.features.length > 0 ? (
                <div className="feature-list">
                  <h3>Declared features</h3>
                  <ul>{detail.preview.features.map((feature) => (
                    <li key={feature.id}><code>{feature.id}</code> — {feature.name}{feature.kind ? ` (${feature.kind})` : ""}</li>
                  ))}</ul>
                </div>
              ) : undefined}
              <h3>Python requirements</h3>
              {environment === undefined
                ? <p className="section-note">Environment metadata is unavailable for this legacy record.</p>
                : environment.requirements.length === 0
                  ? <p className="section-note">No additional Python requirements are declared.</p>
                  : <ul className="requirements">{environment.requirements.map((requirement) => <li key={requirement}><code>{requirement}</code></li>)}</ul>}
            </section>
            <section aria-labelledby="dependencies-heading" className="record-section">
              <p className="section-number">3</p>
              <h2 id="dependencies-heading">Repository dependencies</h2>
              {detail.closure.length === 0 ? <p className="section-note">No repository dependencies are recorded.</p> : (
                <div className="table-scroll"><table>
                  <thead><tr><th>Repository</th><th>Exact revision</th></tr></thead>
                  <tbody>{detail.closure.map((pin) => (
                    <tr key={`${pin.repository}@${pin.commit}`}><td>{pin.repository}</td><td><code title={pin.commit}>{pin.commit.slice(0, 12)}</code></td></tr>
                  ))}</tbody>
                </table></div>
              )}
            </section>
            <section aria-labelledby="documentation-heading" className="record-section">
              <p className="section-number">4</p>
              <h2 id="documentation-heading">Documentation</h2>
              <Documentation detail={detail} documentation={record.documentation} />
            </section>
            <section aria-labelledby="releases-heading" className="record-section">
              <p className="section-number">5</p>
              <h2 id="releases-heading">Release record</h2>
              <label htmlFor="release-select">Exact published release</label>
              <select
                id="release-select"
                onChange={(event) => host.postMessage({ entry: event.target.value, kind: "select-release" })}
                value={detail.id}
              >
                {detail.releases.map((release, index) => (
                  <option key={release.id} value={release.id}>
                    {release.commit.slice(0, 12)} · {date(release.published_at)}{index === 0 ? " · latest visible" : ""}
                  </option>
                ))}
              </select>
            </section>
            <section aria-labelledby="reference-heading" className="record-section citation-block">
              <p className="section-number">Reference</p>
              <h2 id="reference-heading">Reproducible citation</h2>
              <pre><code>{exactReference(detail)}</code></pre>
            </section>
          </article>
          <aside aria-label="Reproducibility record" className="record-aside">
            <h2>Reproducibility record</h2>
            <Metadata detail={detail} />
          </aside>
        </div>
      </main>
      <footer className="record-footer">
        <p>{inspectionFooterText(record.inspection)}</p>
        <RecordActions record={record} />
      </footer>
    </div>
  );
}

function Catalogue() {
  const [message, setMessage] = useState<HostToCatalogue | undefined>();
  useEffect(() => {
    const listen = (event: MessageEvent) => setMessage(event.data as HostToCatalogue);
    window.addEventListener("message", listen);
    host.postMessage({ kind: "ready" });
    return () => window.removeEventListener("message", listen);
  }, []);
  if (message === undefined) return <p className="booting">Opening catalogue…</p>;
  return message.kind === "listing"
    ? <CatalogueSidebar initial={message.listing} />
    : <CatalogueRecordPage initial={message.record} />;
}

createRoot(document.getElementById("root")!).render(<Catalogue />);
