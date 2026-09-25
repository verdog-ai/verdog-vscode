/** AGPL-3.0-only with the additional permission in LICENSE-EXCEPTION. */

/**
 * @fileoverview The clone as the source of truth.
 *
 * The canvas receives one snapshot from the extension host. This builds it from the working
 * copy: the graph and the layout come straight out of `project.json`, and
 * `entity_documents` -- which the server computes -- is derivable here because the paths
 * are a convention, not data.
 *
 * Diagnostics need the compiler, so they arrive from `verdog check`; `checked` stays false
 * until one has run, which the canvas renders as "unchecked" rather than "clean".
 */

import {promises as fs} from 'node:fs';
import * as path from 'node:path';

import {graphHash} from './graph';
import {array, entries, object, text} from '../model/reading';
import {
  moduleDocumentPaths,
  visitDocumentPaths,
  type DocumentRefs,
} from '../model/documents';
import {packageDirectory, packageProblem} from '../model/names';
import {
  definitionIndex,
  definitionKey,
  subroutinesIn,
  definitionPath,
  SCHEMA_VERSION,
  type CanonicalProject,
} from '../model/project';
import {
  ownerRoot,
  qualifiedKey,
  subroutineAddress,
  type ProjectSnapshot,
} from '../model/snapshot';
import {directProjectPath} from './projectPath';

/** Where a pinned dependency is checked out. The CLI's `EXTERNAL_ROOT`, mirrored. */
const EXTERNAL_ROOT = 'external';

/** Whether a file belongs to the project's protected projection, or is outside this project. */
export function projectFileReadonly(
  root: string,
  file: string,
  snapshot: {pinned: Readonly<Record<string, unknown>>; project: unknown},
): boolean | undefined {
  const relativeTo = (owner: string): string | undefined => {
    const relative = path.relative(owner, file);
    const parts = relative.split(path.sep);
    return path.isAbsolute(relative) || parts[0] === '..'
      ? undefined
      : parts.join('/');
  };
  if (relativeTo(root) === undefined) {
    return undefined;
  }

  const owners: Array<[string, unknown]> = [
    [root, snapshot.project],
    ...Object.entries(snapshot.pinned).map(
      ([owner, project]) =>
        [path.join(root, ...ownerRoot(owner).split('/')), project] as [
          string,
          unknown,
        ],
    ),
  ];
  owners.sort(([left], [right]) => right.length - left.length);
  const found = owners
    .map(([owner, project]) => ({project, sourcePath: relativeTo(owner)}))
    .find(({sourcePath}) => sourcePath !== undefined);
  if (found === undefined) {
    return false;
  }
  return array(object(found.project).sources).some(entry => {
    const source = object(entry);
    return (
      text(source.path) === found.sourcePath && source.ownership === 'generated'
    );
  });
}

/**
 * Which clone holds a subroutine's `project.json`, and what the subroutine is called there.
 *
 * The canvas names a pinned subroutine `<alias path>/<id>`, because two projects may each have a
 * `main`. Each alias in the path is relative to the project before it, so
 * `acme.tools/acme.parser/main` lives at
 * `external/acme/tools/external/acme/parser`. The submodule's own graph knows nothing about
 * the prefix its owners added -- so an edit needs both halves undone, together.
 *
 * A prefix only counts when it names an alias path actually pinned here. Workflow ids cannot
 * contain `/`, so a lone id is unambiguous; checking against `pinned` is what stops a
 * hand-written oddity being mistaken for a package.
 */
export function subroutineFile(
  root: string,
  subroutineId: string,
  pinned: Readonly<Record<string, unknown>>,
): {root: string; subroutine: string} {
  const {ownerPath, subroutine} = subroutineAddress(pinned, subroutineId);
  if (ownerPath === undefined) {
    return {root, subroutine};
  }
  return {
    root: path.join(
      root,
      ...ownerPath
        .split('/')
        .flatMap(alias => [EXTERNAL_ROOT, packageDirectory(alias)]),
    ),
    subroutine,
  };
}

function refs(
  present: Set<string>,
  paths: DocumentRefs,
): DocumentRefs | undefined {
  const found: Partial<DocumentRefs> = {};
  for (const [key, candidate] of Object.entries(paths) as Array<
    [keyof DocumentRefs, string]
  >) {
    if (present.has(candidate)) {
      (found as Record<string, string>)[key] = candidate;
    }
  }
  if (!found.declaration) {
    return undefined;
  }
  return found as DocumentRefs;
}

export async function readClone(root: string): Promise<ProjectSnapshot> {
  const raw = await fs.readFile(path.join(root, 'project.json'), 'utf8');
  const decoded = object(JSON.parse(raw) as unknown);
  // An old clone read by a new extension -- or the reverse -- is a real state rather than a
  // bug, and it deserves a sentence instead of a canvas quietly drawing the wrong thing. This
  // used to live in a `parseProjectSnapshot` nothing called, which is to say it did not live
  // anywhere; the check belongs on the path that actually reads the file.
  const version = decoded.schema_version;
  if (version !== SCHEMA_VERSION) {
    throw new Error(
      `this project is schema v${String(version)} and this extension draws v${SCHEMA_VERSION}. ` +
        (typeof version === 'number' && version < SCHEMA_VERSION
          ? `Schema v${String(version)} is unsupported; recreate it as schema v${SCHEMA_VERSION}.`
          : 'Update the Verdog extension.'),
    );
  }
  const project = decoded as CanonicalProject;

  const entityDocuments: ProjectSnapshot['entity_documents'] = {
    edges: {},
    features: {},
    nodes: {},
    profile_parameters: {},
    profiles: {},
    session_parameters: {},
    sessions: {},
  };

  /**
   * Derive one project's entity documents into `entityDocuments`.
   *
   * Factored out because it now runs more than once: your own project, and then each pinned
   * one, whose graph the canvas can draw even though you may not edit it. The convention is
   * identical -- each path comes from the central definition index -- so running the same function
   * against a different root and a different key is the whole of the difference. Writing it
   * twice is how the preview and the clone drifted before.
   *
   * `prefix` is where that project sits relative to this clone (empty for your own), and
   * `key` namespaces a pinned subroutine so its id cannot collide with one of yours.
   */
  const derive = (
    project: CanonicalProject,
    prefix: string,
    key: (subroutineId: string) => string,
  ): void => {
    const owner = text(project.package);
    // A pinned project's manifest lists its own files, relative to its own root -- the parent
    // manifest does not mention them at all -- so the set is built from that and prefixed.
    const listed = new Set(
      array(project.sources)
        .map(entry => text(object(entry).path))
        .filter(Boolean)
        .map(relative => `${prefix}${relative}`),
    );
    for (const subroutine of subroutinesIn(project)) {
      const subroutineId = subroutine.id;
      const definition = definitionPath(project, 'subroutine', subroutineId);
      if (definition === undefined) {
        continue;
      }
      const at = key(subroutineId);
      const base = `${prefix}src/${packageDirectory(owner)}/${definition.join('/')}`;
      entityDocuments.nodes[at] = {};
      for (const raw of entries(subroutine.nodes)) {
        const id = text(raw.id);
        const found = refs(
          listed,
          moduleDocumentPaths(`${base}/nodes/${id}`, raw.kind !== 'feature'),
        );
        if (id && found) {
          entityDocuments.nodes[at][id] = found;
        }
      }
      entityDocuments.features[at] = {};
      for (const raw of entries(subroutine.features)) {
        const id = text(raw.id);
        const found = refs(
          listed,
          moduleDocumentPaths(`${base}/features/${id}`, false),
        );
        if (id && found !== undefined) {
          entityDocuments.features[at][id] = found;
        }
      }
      const resources = (
        collection:
          'profile_parameters' | 'profiles' | 'session_parameters' | 'sessions',
        directory: 'profiles' | 'sessions',
      ): void => {
        entityDocuments[collection][at] = {};
        for (const raw of entries(subroutine[collection])) {
          const id = text(raw.id);
          const found = refs(
            listed,
            moduleDocumentPaths(`${base}/${directory}/${id}`, false),
          );
          if (id && found !== undefined) {
            entityDocuments[collection][at][id] = found;
          }
        }
      };
      resources('profile_parameters', 'profiles');
      resources('profiles', 'profiles');
      resources('session_parameters', 'sessions');
      resources('sessions', 'sessions');
      entityDocuments.edges[at] = {};
      for (const raw of entries(subroutine.edges)) {
        const id = text(raw.id);
        if (!id) {
          continue;
        }
        const declaration = refs(
          listed,
          moduleDocumentPaths(`${base}/edges/${id}`, false),
        );
        if (declaration === undefined) {
          continue;
        }
        const visit = refs(
          listed,
          visitDocumentPaths(`${base}/nodes/${text(raw.target)}`, {id}),
        );
        entityDocuments.edges[at][id] = {
          ...declaration,
          ...(visit === undefined ? {} : {visit}),
        };
      }
    }
    for (const definition of definitionIndex(project).definitions.values()) {
      if (
        definition.kind !== 'workflow' ||
        definition.workflow === undefined ||
        definition.path === undefined
      ) {
        continue;
      }
      const at = key(definitionKey('workflow', definition.id));
      const base = `${prefix}src/${packageDirectory(owner)}/${definition.path.join('/')}`;
      entityDocuments.profiles[at] = {};
      for (const profile of entries(definition.workflow.profiles)) {
        const id = text(profile.id);
        const found = refs(
          listed,
          moduleDocumentPaths(`${base}/profiles/${id}`, false),
        );
        if (id && found !== undefined) {
          entityDocuments.profiles[at][id] = found;
        }
      }
      entityDocuments.sessions[at] = {};
      for (const session of entries(definition.workflow.sessions)) {
        const id = text(session.id);
        const found = refs(
          listed,
          moduleDocumentPaths(`${base}/sessions/${id}`, false),
        );
        if (id && found !== undefined) {
          entityDocuments.sessions[at][id] = found;
        }
      }
    }
  };

  derive(project, '', subroutineId => subroutineId);

  /**
   * The subroutines of pinned dependencies at every depth, so a call node standing for one can be
   * entered. A dependency owns its own direct pins; the parent never flattens their manifests.
   *
   * The card's lock used to say there was no local graph to open. There is: a pin is a git
   * submodule, checked out at the commit the graph names, with its own `project.json` beside
   * its sources. What the lock actually means is that the code is its author's -- read it,
   * never write it -- and that is a mode the canvas already has.
   *
   * A pin whose submodule was never fetched is skipped rather than reported here: `verdog
   * check` already says so, with the commit and the command to fix it.
   */
  const pinned: Record<string, CanonicalProject> = {};
  const readPins = async (
    owner: CanonicalProject,
    ownerPrefix = '',
    ownerPath?: string,
  ): Promise<void> => {
    for (const entry of array(owner.externals)) {
      const alias = text(object(entry).alias);
      if (!alias || packageProblem(alias)) {
        continue;
      }
      const aliasPath = qualifiedKey(ownerPath, alias);
      const prefix = `${ownerPrefix}${EXTERNAL_ROOT}/${packageDirectory(alias)}/`;
      try {
        const manifestPath = await directProjectPath(
          root,
          `${prefix}project.json`,
        );
        const manifest = await fs.readFile(manifestPath, 'utf8');
        const project = object(
          JSON.parse(manifest) as unknown,
        ) as CanonicalProject;
        pinned[aliasPath] = project;
        derive(project, prefix, subroutineId =>
          qualifiedKey(aliasPath, subroutineId),
        );
        await readPins(project, prefix, aliasPath);
      } catch {
        continue;
      }
    }
  };
  await readPins(project);
  const {rootSubroutine, rootWorkflow} = definitionIndex(project);

  return {
    // Locally you can do everything: there is no tenant to be a viewer of. The service
    // still decides on `save`, which is where authorization actually belongs.
    checked: false,
    diagnostic_count: 0,
    editable: true,
    entity_documents: entityDocuments,
    graph_hash: graphHash(project),
    initial_scope:
      rootWorkflow === undefined
        ? (rootSubroutine ?? '')
        : definitionKey('workflow', rootWorkflow),
    pinned,
    project,
  };
}
