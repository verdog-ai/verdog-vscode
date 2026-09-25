// AGPL-3.0-only with the additional permission in LICENSE-EXCEPTION.
import { definitionIdentifierProblem, packageProblem } from "./names";

export type CatalogueVisibility = "public" | "restricted";

export type CataloguePin = { commit: string; repository: string };

export type CatalogueRelease = {
  commit: string;
  id: string;
  published_at: string;
  scope?: "private" | "public";
  updated_at?: string;
  visibility: CatalogueVisibility;
};

export type CataloguePreviewNode = { id: string; kind: string; name: string };
export type CataloguePreviewEdge = { id: string; name: string; source: string; target: string };
export type CataloguePreviewFeature = { id: string; kind?: string; name: string };

export type CataloguePreview = {
  /** Canonical publisher payload, retained for exact Stage-two source comparison. */
  canonical: Record<string, unknown>;
  edges: CataloguePreviewEdge[];
  features: CataloguePreviewFeature[];
  name: string;
  nodes: CataloguePreviewNode[];
  ports: Record<string, string>;
};

export type CatalogueEnvironment = {
  python?: string;
  requirements: string[];
  runtime?: string;
  schema_version?: number;
};

/** Compact row returned by catalogue listing. */
export type CatalogueSummary = {
  commit: string;
  dependency_count: number;
  description: string | null;
  display_name: string;
  id: string;
  package: string | null;
  published_at: string;
  published_by_me: boolean;
  release_count: number;
  releases: CatalogueRelease[];
  repository: string;
  /** Retained while older CLIs still return the publisher-selected name. */
  scope?: "private" | "public";
  updated_at?: string;
  visibility: CatalogueVisibility;
  workflow_id: string;
};

/** Exact-release record returned by `catalogue --entry`. */
export type CatalogueDetail = CatalogueSummary & {
  closure: CataloguePin[];
  environment?: CatalogueEnvironment;
  preview?: CataloguePreview;
};

/** Compatibility name for consumers written against the first catalogue model. */
export type CatalogueEntry = CatalogueSummary;

export type CatalogueListing = {
  detail?: string;
  entries: CatalogueSummary[];
  login?: string;
  next_cursor?: string;
  state: "empty" | "listed" | "loading" | "unauthenticated" | "unavailable";
};

export type DecodedCatalogueListing = {
  entries: CatalogueSummary[];
  login?: string;
  next_cursor?: string;
  rejected: string[];
};

export type CatalogueDocumentation =
  | { state: "loading" }
  | { detail: string; state: "absent" | "unavailable" }
  | { markdown: string; path: string; state: "ready" };

export type CatalogueInspection =
  | { state: "idle" }
  | { detail: string; phase?: string; state: "running" }
  | { detail: string; folder?: string; state: "incomplete" | "mismatch" }
  | { folder: string; state: "ready" };

export type CatalogueRecord = {
  detail?: CatalogueDetail;
  documentation: CatalogueDocumentation;
  inspection: CatalogueInspection;
  message?: string;
  requested: string;
  state: "loading" | "ready" | "unavailable";
};

export type CatalogueDescriptor = {
  closure: CataloguePin[];
  display_name: string;
  environment?: CatalogueEnvironment;
  package: string;
  preview: CataloguePreview;
  schema_version?: number;
  workflow_id: string;
};

const record = (value: unknown, name: string): Record<string, unknown> => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name} must be an object`);
  }
  return value as Record<string, unknown>;
};

const string = (value: unknown, name: string): string => {
  if (typeof value !== "string" || value === "") throw new Error(`${name} must be a string`);
  return value;
};

const optionalString = (value: unknown, name: string): string | null =>
  value === null || value === undefined ? null : string(value, name);

const optionalTimestamp = (value: unknown, name: string): string | undefined =>
  value === undefined || value === null ? undefined : publishedAt(value, name);

const integer = (value: unknown, fallback: number): number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : fallback;

const COMMIT = /^[0-9a-f]{40}$/i;
const REPOSITORY_OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/;
const REPOSITORY_NAME = /^[A-Za-z0-9._-]+$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const commit = (value: unknown, name: string): string => {
  const found = string(value, name);
  if (!COMMIT.test(found)) throw new Error(`${name} must be a 40-digit commit hash`);
  return found.toLowerCase();
};

const repository = (value: unknown, name: string): string => {
  const found = string(value, name);
  const parts = found.split("/");
  if (
    parts.length !== 2 ||
    !REPOSITORY_OWNER.test(parts[0]) ||
    !REPOSITORY_NAME.test(parts[1]) ||
    parts[1] === "." ||
    parts[1] === ".."
  ) throw new Error(`${name} must be owner/repository`);
  return found;
};

const entryId = (value: unknown, name: string): string => {
  const found = string(value, name);
  if (!UUID.test(found)) throw new Error(`${name} must be a UUID`);
  return found;
};

const publishedAt = (value: unknown, name: string): string => {
  const found = string(value, name);
  if (Number.isNaN(Date.parse(found))) throw new Error(`${name} must be a timestamp`);
  return found;
};

function visibility(raw: Record<string, unknown>, name: string): CatalogueVisibility {
  if (raw.visibility === "public" || raw.visibility === "restricted") return raw.visibility;
  if (raw.scope === "public") return "public";
  if (raw.scope === "private") return "restricted";
  throw new Error(`${name}.visibility must be public or restricted`);
}

function legacyScope(raw: Record<string, unknown>, name: string): "private" | "public" | undefined {
  if (raw.scope === undefined || raw.scope === null) return undefined;
  if (raw.scope === "private" || raw.scope === "public") return raw.scope;
  throw new Error(`${name}.scope must be public or private`);
}

const release = (
  value: unknown,
  name: string,
  inheritedVisibility: CatalogueVisibility,
): CatalogueRelease => {
  const raw = record(value, name);
  const scope = legacyScope(raw, name);
  const updated = optionalTimestamp(raw.updated_at, `${name}.updated_at`);
  return {
    commit: commit(raw.commit, `${name}.commit`),
    id: entryId(raw.id, `${name}.id`),
    published_at: publishedAt(raw.published_at, `${name}.published_at`),
    ...(scope === undefined ? {} : { scope }),
    ...(updated === undefined ? {} : { updated_at: updated }),
    visibility: raw.visibility === undefined && raw.scope === undefined
      ? inheritedVisibility
      : visibility(raw, name),
  };
};

function pin(value: unknown, name: string): CataloguePin {
  const raw = record(value, name);
  const repositoryName = raw.repository ?? (
    typeof raw.owner === "string" && typeof raw.name === "string"
      ? `${raw.owner}/${raw.name}`
      : undefined
  );
  return {
    commit: commit(raw.commit, `${name}.commit`),
    repository: repository(repositoryName, `${name}.repository`),
  };
}

function object(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function preview(value: unknown, workflowId: string): CataloguePreview | undefined {
  const raw = object(value);
  if (raw === undefined) return undefined;
  const nodes = Array.isArray(raw.nodes) ? raw.nodes.flatMap((value) => {
    const node = object(value);
    if (node === undefined || typeof node.id !== "string") return [];
    return [{
      id: node.id,
      kind: typeof node.kind === "string" ? node.kind : "node",
      name: typeof node.name === "string" && node.name ? node.name : node.id,
    }];
  }) : [];
  const ids = new Set(nodes.map(({ id }) => id));
  const edges = Array.isArray(raw.edges) ? raw.edges.flatMap((value) => {
    const edge = object(value);
    if (
      edge === undefined || typeof edge.id !== "string" ||
      typeof edge.source !== "string" || typeof edge.target !== "string" ||
      !ids.has(edge.source) || !ids.has(edge.target)
    ) return [];
    return [{
      id: edge.id,
      name: typeof edge.name === "string" && edge.name ? edge.name : edge.id,
      source: edge.source,
      target: edge.target,
    }];
  }) : [];
  const features = Array.isArray(raw.features) ? raw.features.flatMap((value) => {
    const feature = object(value);
    if (feature === undefined || typeof feature.id !== "string") return [];
    return [{
      id: feature.id,
      ...(typeof feature.kind === "string" ? { kind: feature.kind } : {}),
      name: typeof feature.name === "string" && feature.name ? feature.name : feature.id,
    }];
  }) : [];
  const rawPorts = object(raw.ports) ?? {};
  const ports = Object.fromEntries(
    Object.entries(rawPorts).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
  return {
    canonical: raw,
    edges,
    features,
    name: typeof raw.name === "string" && raw.name ? raw.name : workflowId,
    nodes,
    ports,
  };
}

function environment(value: unknown): CatalogueEnvironment | undefined {
  const raw = object(value);
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw.requirements)) {
    throw new Error("entry.environment.requirements must be an array");
  }
  if (raw.requirements.some((item) => typeof item !== "string" || item.length === 0)) {
    throw new Error("entry.environment.requirements must contain non-empty strings");
  }
  const requirements = raw.requirements as string[];
  if (new Set(requirements).size !== requirements.length) {
    throw new Error("entry.environment.requirements must not contain duplicates");
  }
  if (raw.python !== undefined && (typeof raw.python !== "string" || raw.python.length === 0)) {
    throw new Error("entry.environment.python must be a non-empty string");
  }
  if (raw.runtime !== undefined && (typeof raw.runtime !== "string" || raw.runtime.length === 0)) {
    throw new Error("entry.environment.runtime must be a non-empty string");
  }
  const schema = raw.schema_version;
  if (
    schema !== undefined &&
    (typeof schema !== "number" || !Number.isSafeInteger(schema) || schema < 1)
  ) throw new Error("entry.environment.schema_version must be a positive integer");
  return {
    ...(typeof raw.python === "string" ? { python: raw.python } : {}),
    requirements: [...new Set(requirements)].sort((left, right) => left.localeCompare(right)),
    ...(typeof raw.runtime === "string" ? { runtime: raw.runtime } : {}),
    ...(typeof schema === "number"
      ? { schema_version: schema }
      : {}),
  };
}

function decode(value: unknown): CatalogueDetail {
  const raw = record(value, "entry");
  const workflowId = string(raw.workflow_id, "entry.workflow_id");
  if (definitionIdentifierProblem(workflowId) !== undefined) {
    throw new Error("entry.workflow_id is not a Verdog definition id");
  }
  const packageName = optionalString(raw.package, "entry.package");
  if (packageName !== null && packageProblem(packageName) !== undefined) {
    throw new Error("entry.package is not a Verdog package");
  }
  const entryVisibility = visibility(raw, "entry");
  const scope = legacyScope(raw, "entry");
  const closure = (raw.closure === undefined
    ? []
    : !Array.isArray(raw.closure)
      ? (() => { throw new Error("entry.closure must be an array"); })()
      : raw.closure.map((value, index) => pin(value, `entry.closure[${index}]`)))
    .sort((left, right) => `${left.repository}@${left.commit}`.localeCompare(`${right.repository}@${right.commit}`));
  if (raw.releases !== undefined && !Array.isArray(raw.releases)) {
    throw new Error("entry.releases must be an array");
  }
  const releases = (raw.releases ?? []) as unknown[];
  const published = publishedAt(raw.published_at, "entry.published_at");
  const decodedReleases = releases.map((value, index) =>
    release(value, `entry.releases[${index}]`, entryVisibility)
  );
  const exactId = entryId(raw.id, "entry.id");
  const exactCommit = commit(raw.commit, "entry.commit");
  if (decodedReleases.length === 0) {
    decodedReleases.push({
      commit: exactCommit,
      id: exactId,
      published_at: published,
      ...(scope === undefined ? {} : { scope }),
      visibility: entryVisibility,
    });
  }
  const updated = optionalTimestamp(raw.updated_at, "entry.updated_at");
  const decodedEnvironment = environment(raw.environment);
  const decodedPreview = preview(raw.preview, workflowId);
  return {
    closure,
    commit: exactCommit,
    dependency_count: integer(raw.repository_dependency_count ?? raw.dependency_count, closure.length),
    description: optionalString(raw.description, "entry.description"),
    display_name: typeof raw.display_name === "string" && raw.display_name
      ? raw.display_name
      : decodedPreview?.name ?? workflowId,
    ...(decodedEnvironment === undefined ? {} : { environment: decodedEnvironment }),
    id: exactId,
    package: packageName,
    ...(decodedPreview === undefined ? {} : { preview: decodedPreview }),
    published_at: published,
    published_by_me: raw.published_by_me === true,
    release_count: integer(raw.release_count, decodedReleases.length),
    releases: decodedReleases,
    repository: repository(raw.repository, "entry.repository"),
    ...(scope === undefined ? {} : { scope }),
    ...(updated === undefined ? {} : { updated_at: updated }),
    visibility: entryVisibility,
    workflow_id: workflowId,
  };
}

/** Decode one remote catalogue summary before it reaches the webview or filesystem. */
export function decodeCatalogueEntry(value: unknown): CatalogueSummary {
  return decode(value);
}

/** Decode the exact release detail, tolerating optional fields from legacy records. */
export function decodeCatalogueDetail(value: unknown): CatalogueDetail {
  return decode(value);
}

export function decodeCatalogueDescriptor(value: unknown): CatalogueDescriptor {
  const raw = record(value, "descriptor");
  const workflowId = string(raw.workflow_id, "descriptor.workflow_id");
  const packageName = string(raw.package, "descriptor.package");
  if (definitionIdentifierProblem(workflowId) !== undefined) {
    throw new Error("descriptor.workflow_id is not a Verdog definition id");
  }
  if (packageProblem(packageName) !== undefined) {
    throw new Error("descriptor.package is not a Verdog package");
  }
  if (!Array.isArray(raw.closure)) throw new Error("descriptor.closure must be an array");
  const decodedPreview = preview(raw.preview, workflowId);
  if (decodedPreview === undefined) throw new Error("descriptor.preview must be an object");
  const decodedEnvironment = environment(raw.environment);
  const schema = raw.schema_version;
  return {
    closure: raw.closure
      .map((value, index) => pin(value, `descriptor.closure[${index}]`))
      .sort((left, right) => `${left.repository}@${left.commit}`.localeCompare(`${right.repository}@${right.commit}`)),
    display_name: typeof raw.display_name === "string" && raw.display_name
      ? raw.display_name
      : decodedPreview.name,
    ...(decodedEnvironment === undefined ? {} : { environment: decodedEnvironment }),
    package: packageName,
    preview: decodedPreview,
    ...(typeof schema === "number" && Number.isSafeInteger(schema)
      ? { schema_version: schema }
      : {}),
    workflow_id: workflowId,
  };
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value === null || typeof value !== "object") return value;
  const raw = value as Record<string, unknown>;
  return Object.fromEntries(Object.keys(raw).sort().map((key) => [key, canonical(raw[key])]));
}

const equivalent = (left: unknown, right: unknown): boolean =>
  JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));

/** Stable expected-metadata identity for invalidating a cached inspection after republish. */
export function catalogueMetadataKey(detail: CatalogueDetail): string {
  return JSON.stringify(canonical({
    closure: detail.closure,
    display_name: detail.display_name,
    environment: detail.environment,
    package: detail.package,
    preview: detail.preview?.canonical,
    workflow_id: detail.workflow_id,
  }));
}

/** Human-readable reasons the publisher's claim differs from the exact fetched commit. */
export function catalogueMetadataDifferences(
  detail: CatalogueDetail,
  descriptor: CatalogueDescriptor,
): string[] {
  const differences: string[] = [];
  if (detail.workflow_id !== descriptor.workflow_id) differences.push("workflow identity");
  if (detail.package !== descriptor.package) differences.push("package");
  if (detail.display_name !== descriptor.display_name) differences.push("display name");
  if (detail.preview === undefined || !equivalent(detail.preview.canonical, descriptor.preview.canonical)) {
    differences.push("workflow structure");
  }
  if (!equivalent(detail.closure, descriptor.closure)) differences.push("repository dependencies");
  if (detail.environment === undefined || !equivalent(detail.environment, descriptor.environment)) {
    differences.push("environment requirements");
  }
  return differences;
}

/** Decode a listing while retaining valid siblings when one remote row is malformed. */
export function decodeCatalogueListing(value: unknown): DecodedCatalogueListing {
  const raw = record(value, "catalogue");
  if (!Array.isArray(raw.entries)) throw new Error("catalogue.entries must be an array");
  const entries: CatalogueSummary[] = [];
  const rejected: string[] = [];
  raw.entries.forEach((entry, index) => {
    try {
      entries.push(decodeCatalogueEntry(entry));
    } catch (error) {
      rejected.push(`entry ${index}: ${error instanceof Error ? error.message : String(error)}`);
    }
  });
  const login = raw.login === undefined ? undefined : string(raw.login, "catalogue.login");
  const next = raw.next_cursor === null || raw.next_cursor === undefined
    ? undefined
    : string(raw.next_cursor, "catalogue.next_cursor");
  return {
    entries,
    ...(login === undefined ? {} : { login }),
    ...(next === undefined ? {} : { next_cursor: next }),
    rejected,
  };
}
