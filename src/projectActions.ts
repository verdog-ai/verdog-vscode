/** AGPL-3.0-only with the additional permission in LICENSE-EXCEPTION. */

import * as vscode from 'vscode';

import * as authoring from './authoring';
import {isRemovalReviewToHost} from '../model/protocolMessages';
import {runVerdogCommand} from './verdogCommand';
import {webviewHtml} from './webviewHtml';
import {
  chooseSubroutine,
  editSubroutine,
  entities,
  followNavigation,
  followNavigationTarget,
  projectOf,
  isEditable,
  locate,
  readAccess,
  refresh,
  runVerb,
  subroutineIds,
  type OpenHost,
} from './projectHost';
import {agentProfiles, agentSessions, type AgentSession} from '../model/agents';
import * as mutate from '../model/editing';
import {
  EXPLANATIONS,
  FEATURE_KINDS,
  FEATURE_KIND_DESCRIPTIONS,
  isFeatureKind,
  observationsFor,
  type Feature,
} from '../model/features';
import {featuresIn} from '../model/grammar';
import {
  agentProfileId,
  agentSessionId,
  type GraphId,
} from '../model/identifiers';
import {entityLabel, identifierProblem} from '../model/names';
import {
  CALL_DEFINITION_KIND,
  CALL_NODE_KINDS,
  callTargets,
  definitionIndex,
  definitionKey,
  DEFINITION_KIND,
  DEFINITION_KINDS,
  edgeDirectionProblem,
  EXECUTABLE_NODE_KINDS,
  graphLeaf,
  NODE_KIND_DESCRIPTIONS,
  isCallNodeKind,
  isExecutableNodeKind,
  qualifyGraph,
  visibleDefinitions,
  workflowId,
  type NodeKind,
  type SubroutineCallArguments,
} from '../model/project';
import type {CanvasAction, HostToRemovalReview} from '../model/protocol';
import {
  externalSubroutineTargets,
  subroutineAddress,
  subroutineCallTarget,
  subroutineIn,
  qualifiedKey,
  type ProjectGraphs,
} from '../model/snapshot';
import {
  definitionComponentEntries,
  definitionTarget,
  removalNavigationEntry,
} from '../webview/navigation';
import {snapshotCanvasGraphs} from '../webview/subroutineGraphs';

const NODE_KIND_CHOICES = EXECUTABLE_NODE_KINDS.map(label => ({
  description: NODE_KIND_DESCRIPTIONS[label],
  label,
}));

const CALL_KIND_CHOICES = CALL_NODE_KINDS.map(label => ({
  description: NODE_KIND_DESCRIPTIONS[label],
  label,
}));

const DEFINITION_KIND_CHOICES = DEFINITION_KINDS.map(definitionKind => ({
  definitionKind,
  description:
    definitionKind === 'workflow'
      ? 'wraps a visible subroutine in its own process'
      : 'defines reusable graph structure in this process',
  label: definitionKind === 'workflow' ? 'Make runnable' : 'subroutine',
}));

const FEATURE_KIND_CHOICES = FEATURE_KINDS.map(label => ({
  description: FEATURE_KIND_DESCRIPTIONS[label],
  label,
}));

function parseEnumValues(value: string): string[] {
  return value
    .split(',')
    .map(member => member.trim())
    .filter(Boolean);
}

function sessionDescription(session: AgentSession): string {
  return session.origin === 'parameter'
    ? 'parameter'
    : `local · ${session.persistent ? 'persistent' : 'fresh'}`;
}

async function createEntity(
  host: OpenHost,
  subroutine: string,
  entity: mutate.Entity,
  describe: string,
  create: (
    project: mutate.Project,
    at: GraphId,
  ) => {
    files?: mutate.AuthoredFileEdit[];
    id: string;
    project: mutate.Project;
  },
  navigationRevision: number,
  workflow?: GraphId,
): Promise<void> {
  let id: string | undefined;
  const saved = await editSubroutine(
    host,
    subroutine,
    describe,
    (project, at) => {
      const result = create(project, at);
      id = result.id;
      return {...result, report: result.id};
    },
  );
  if (
    !saved ||
    id === undefined ||
    host.navigationRevision !== navigationRevision ||
    host.snapshot === undefined
  ) {
    return;
  }
  const snapshot = host.snapshot;
  const {ownerPath} = subroutineAddress(snapshot.pinned, subroutine);
  const scope =
    workflow === undefined
      ? subroutine
      : qualifiedKey(ownerPath, definitionKey('workflow', workflow));
  const current = snapshotCanvasGraphs(snapshot)[scope];
  if (current === undefined) {
    return;
  }
  const inspection = definitionTarget(snapshot, current)?.inspection;
  if (inspection === undefined) {
    return;
  }
  const target = definitionComponentEntries(snapshot, current, inspection).find(
    entry => entry.entity === entity && entry.id === id,
  )?.target;
  if (target !== undefined) {
    await followNavigationTarget(host, target);
  }
}

function enumValuesProblem(value: string): string | undefined {
  const members = parseEnumValues(value);
  if (members.length === 0) {
    return 'Enter at least one value.';
  }
  const problem = members
    .map(identifierProblem)
    .find(item => item !== undefined);
  if (problem !== undefined) {
    return problem;
  }
  return new Set(members).size === members.length
    ? undefined
    : 'Each value must be unique.';
}

async function addNodeHere(
  host: OpenHost,
  subroutineId: string | undefined,
  given?: {kind?: string; name?: string; profile?: string; session?: string},
): Promise<void> {
  const navigationRevision = host.navigationRevision;
  const subroutine = subroutineId ?? (await chooseSubroutine(host));
  if (subroutine === undefined) {
    return;
  }
  const kind =
    given?.kind ??
    (
      await vscode.window.showQuickPick(NODE_KIND_CHOICES, {
        title: 'What kind of node?',
      })
    )?.label;
  if (!isExecutableNodeKind(kind)) {
    return;
  }
  const name =
    given?.name ??
    (await vscode.window.showInputBox({
      prompt: 'What does this node do?',
      title: `New ${kind} node`,
    }));
  if (name === undefined || !name.trim()) {
    return;
  }
  const detail =
    kind === 'agent'
      ? await agentAssignment(host, subroutine, given)
      : undefined;
  if (kind === 'agent' && detail === undefined) {
    return;
  }
  await createEntity(
    host,
    subroutine,
    'nodes',
    `Added ${kind} node "${name.trim()}"`,
    (project, at) => mutate.addNode(project, at, kind, name, undefined, detail),
    navigationRevision,
  );
}

async function agentAssignment(
  host: OpenHost,
  subroutine: string,
  given?: {profile?: string; session?: string},
): Promise<mutate.AgentAssignment | undefined> {
  const graph =
    host.snapshot === undefined
      ? undefined
      : subroutineIn(host.snapshot, subroutine);
  const profiles = agentProfiles(graph);
  const sessions = agentSessions(graph);
  if (profiles.length === 0 || sessions.length === 0) {
    void vscode.window.showInformationMessage(
      `Add ${profiles.length === 0 ? 'a profile' : 'a session'} to this subroutine first.`,
    );
    return undefined;
  }
  const selectedProfile =
    given?.profile === undefined
      ? (
          await vscode.window.showQuickPick(
            profiles.map(profile => ({
              description: profile.origin,
              label: profile.name,
              value: profile.id,
            })),
            {title: 'Which profile should this agent use?'},
          )
        )?.value
      : agentProfileId(given.profile);
  if (
    selectedProfile === undefined ||
    !profiles.some(({id}) => id === selectedProfile)
  ) {
    return undefined;
  }
  const selectedSession =
    given?.session === undefined
      ? (
          await vscode.window.showQuickPick(
            sessions.map(session => ({
              description: sessionDescription(session),
              label: session.name,
              value: session.id,
            })),
            {title: 'Which session should this agent use?'},
          )
        )?.value
      : agentSessionId(given.session);
  return selectedSession !== undefined &&
    sessions.some(({id}) => id === selectedSession)
    ? {profile: selectedProfile, session: selectedSession}
    : undefined;
}

async function callArguments(
  host: OpenHost,
  caller: string,
  target: string,
): Promise<SubroutineCallArguments | undefined> {
  const snapshot = host.snapshot;
  const graph =
    snapshot === undefined ? undefined : subroutineIn(snapshot, caller);
  const child =
    snapshot === undefined
      ? undefined
      : subroutineCallTarget(snapshot, caller, target);
  if (graph === undefined || child === undefined) {
    void vscode.window.showInformationMessage(
      `Cannot inspect subroutine ${target}.`,
    );
    return undefined;
  }
  const availableProfiles = agentProfiles(graph);
  const profileArguments: SubroutineCallArguments['profile_arguments'] = {};
  for (const parameter of child.profile_parameters) {
    if (availableProfiles.length === 0) {
      void vscode.window.showInformationMessage(
        `Add a profile or profile parameter to this subroutine before binding ${parameter.id}.`,
      );
      return undefined;
    }
    const selected = await vscode.window.showQuickPick(
      availableProfiles.map(profile => ({
        description: profile.origin,
        label: profile.name,
        value: profile.id,
      })),
      {title: `${parameter.name}: which caller profile?`},
    );
    if (selected === undefined) {
      return undefined;
    }
    profileArguments[parameter.id] = selected.value;
  }

  const availableSessions = agentSessions(graph);
  const sessionArguments: SubroutineCallArguments['session_arguments'] = {};
  for (const parameter of child.session_parameters) {
    if (availableSessions.length === 0) {
      void vscode.window.showInformationMessage(
        `Add a session or session parameter to this subroutine before binding ${parameter.id}.`,
      );
      return undefined;
    }
    const selected = await vscode.window.showQuickPick(
      availableSessions.map(session => ({
        description: sessionDescription(session),
        label: session.name,
        value: session.id,
      })),
      {title: `${parameter.name}: which caller session?`},
    );
    if (selected === undefined) {
      return undefined;
    }
    sessionArguments[parameter.id] = selected.value;
  }
  return {
    profile_arguments: profileArguments,
    session_arguments: sessionArguments,
  };
}

async function addDefinitionHere(
  host: OpenHost,
  parentId?: string,
  given?: {kind?: string; name?: string; target?: string},
): Promise<void> {
  const navigationRevision = host.navigationRevision;
  const parent = parentId ?? (await chooseSubroutine(host));
  if (parent === undefined) {
    return;
  }
  const kind =
    given?.kind ??
    (
      await vscode.window.showQuickPick(DEFINITION_KIND_CHOICES, {
        title: 'What should be added?',
      })
    )?.definitionKind;
  if (kind !== 'workflow' && kind !== 'subroutine') {
    return;
  }
  if (kind === 'workflow') {
    const at = locate(host, parent);
    const project = projectOf(host, parent);
    const available = visibleDefinitions(
      project,
      at.subroutine,
      'subroutine',
    ).filter(
      definition =>
        !definitionIndex(project).definitions.has(
          definitionKey(
            'workflow',
            qualifyGraph(at.subroutine, graphLeaf(definition.id)),
          ),
        ),
    );
    if (available.length === 0) {
      void vscode.window.showInformationMessage(
        'Every visible subroutine is already runnable.',
      );
      return;
    }
    const target =
      given?.target ??
      (
        await vscode.window.showQuickPick(
          available.map(definition => ({
            description: definition.id,
            label: definition.name,
            target: definition.id,
          })),
          {title: 'Which subroutine should become runnable?'},
        )
      )?.target;
    if (
      target === undefined ||
      !available.some(definition => definition.id === target)
    ) {
      return;
    }
    await createEntity(
      host,
      parent,
      'workflows',
      `Added workflow definition for "${target}"`,
      (next, owner) => mutate.addWorkflowDefinition(next, owner, target),
      navigationRevision,
    );
    return;
  }
  const name =
    given?.name ??
    (await vscode.window.showInputBox({
      prompt: 'What does this subroutine do?',
      title: 'New subroutine definition',
    }));
  if (name === undefined || !name.trim()) {
    return;
  }
  await createEntity(
    host,
    parent,
    'subroutines',
    `Added subroutine definition "${name.trim()}"`,
    (project, at) => mutate.addSubroutineDefinition(project, name, at),
    navigationRevision,
  );
}

async function addCallHere(
  host: OpenHost,
  subroutineId?: string,
  given?: {kind?: string; name?: string; target?: string},
): Promise<void> {
  const navigationRevision = host.navigationRevision;
  const subroutine = subroutineId ?? (await chooseSubroutine(host));
  if (subroutine === undefined) {
    return;
  }
  const kind =
    given?.kind ??
    (
      await vscode.window.showQuickPick(CALL_KIND_CHOICES, {
        title: 'What kind of call?',
      })
    )?.label;
  if (!isCallNodeKind(kind)) {
    return;
  }
  const expected = CALL_DEFINITION_KIND[kind];
  const at = locate(host, subroutine);
  const external =
    host.snapshot === undefined
      ? []
      : externalSubroutineTargets(host.snapshot, subroutine);
  const targets = callTargets(
    projectOf(host, subroutine),
    at.subroutine,
    expected,
    external,
  );
  const target =
    given?.target ??
    (
      await vscode.window.showQuickPick(
        targets.map(definition => ({
          description:
            definition.externalAlias !== undefined
              ? `external · ${definition.externalAlias}`
              : definition.external === undefined
                ? 'local'
                : `external · ${definition.external.alias}`,
          label: definition.id,
        })),
        {title: `Which ${expected} does this call?`},
      )
    )?.label;
  if (target === undefined) {
    return;
  }
  const name =
    given?.name ??
    (await vscode.window.showInputBox({
      prompt: 'What does this call do?',
      title: `Call ${target}`,
      value: `Call ${target}`,
    }));
  if (name === undefined || !name.trim()) {
    return;
  }
  const args =
    kind === 'subroutine_call'
      ? await callArguments(host, subroutine, target)
      : undefined;
  if (kind === 'subroutine_call' && args === undefined) {
    return;
  }
  await createEntity(
    host,
    subroutine,
    'nodes',
    `Added ${kind} "${name.trim()}"`,
    (project, local) =>
      mutate.addCall(project, local, kind, name, target, undefined, args),
    navigationRevision,
  );
}

async function addFeatureHere(
  host: OpenHost,
  subroutineId?: string,
  given?: {
    description?: string;
    kind?: string;
    label?: string;
    values?: string[];
  },
): Promise<void> {
  const navigationRevision = host.navigationRevision;
  const subroutine = subroutineId ?? (await chooseSubroutine(host));
  if (subroutine === undefined) {
    return;
  }
  const kind =
    given?.kind ??
    (
      await vscode.window.showQuickPick(FEATURE_KIND_CHOICES, {
        title: 'What kind of feature?',
      })
    )?.label;
  if (!isFeatureKind(kind)) {
    return;
  }
  const label =
    given?.label ??
    (await vscode.window.showInputBox({
      prompt: 'What is it called?',
      title: `New ${kind} feature`,
    }));
  if (label === undefined || !label.trim()) {
    return;
  }
  const description =
    given?.description ??
    (await vscode.window.showInputBox({
      prompt:
        'What does it mean? An agent reads this, and the compiler requires it.',
      title: label.trim(),
    }));
  if (description === undefined) {
    return;
  }
  let values = given?.values;
  if (kind === 'enum' && values === undefined) {
    const typed = await vscode.window.showInputBox({
      prompt: 'Comma-separated identifiers, such as pending, running, done.',
      title: `${label.trim()} values`,
      validateInput: enumValuesProblem,
    });
    if (typed === undefined) {
      return;
    }
    values = parseEnumValues(typed);
  }
  await createEntity(
    host,
    subroutine,
    'features',
    `Added ${kind} feature "${label.trim()}"`,
    (project, at) =>
      mutate.addFeature(project, at, kind, label, description, values),
    navigationRevision,
  );
}

async function resourceParameter(
  given?: boolean,
): Promise<boolean | undefined> {
  if (given !== undefined) {
    return given;
  }
  return (
    await vscode.window.showQuickPick(
      [
        {
          description: 'owned by this subroutine',
          label: 'Local definition',
          parameter: false,
        },
        {
          description: 'supplied by the caller',
          label: 'Parameter',
          parameter: true,
        },
      ],
      {title: 'What kind of resource?'},
    )
  )?.parameter;
}

async function addProfileHere(
  host: OpenHost,
  subroutineId?: string,
  given?: {name?: string; parameter?: boolean},
  workflow?: GraphId,
): Promise<void> {
  const navigationRevision = host.navigationRevision;
  const subroutine = subroutineId ?? (await chooseSubroutine(host));
  if (subroutine === undefined) {
    return;
  }
  const parameter =
    workflow === undefined ? await resourceParameter(given?.parameter) : false;
  if (parameter === undefined) {
    return;
  }
  const name =
    given?.name ??
    (await vscode.window.showInputBox({
      prompt: 'What is this profile called?',
      title:
        workflow !== undefined
          ? 'New workflow profile'
          : parameter
            ? 'New profile parameter'
            : 'New local profile',
    }));
  if (name === undefined || !name.trim()) {
    return;
  }
  await createEntity(
    host,
    subroutine,
    parameter ? 'profile_parameters' : 'profiles',
    `Added profile ${name.trim()}`,
    (project, at) =>
      workflow === undefined
        ? mutate.addAgentProfile(project, at, name, parameter)
        : mutate.addWorkflowProfile(project, workflow, name),
    navigationRevision,
    workflow,
  );
}

async function addSessionHere(
  host: OpenHost,
  subroutineId?: string,
  given?: {name?: string; parameter?: boolean; persistent?: boolean},
  workflow?: GraphId,
): Promise<void> {
  const navigationRevision = host.navigationRevision;
  const subroutine = subroutineId ?? (await chooseSubroutine(host));
  if (subroutine === undefined) {
    return;
  }
  const parameter =
    workflow === undefined ? await resourceParameter(given?.parameter) : false;
  if (parameter === undefined) {
    return;
  }
  const name =
    given?.name ??
    (await vscode.window.showInputBox({
      prompt: 'What is this session called?',
      title:
        workflow !== undefined
          ? 'New workflow session'
          : parameter
            ? 'New session parameter'
            : 'New local session',
    }));
  if (name === undefined || !name.trim()) {
    return;
  }
  const persistent = parameter
    ? undefined
    : (given?.persistent ??
      (
        await vscode.window.showQuickPick(
          [
            {
              description: 'kept across invocations',
              label: 'Persistent',
              value: true,
            },
            {
              description: 'starts fresh for each invocation',
              label: 'Fresh',
              value: false,
            },
          ],
          {title: 'How long does this session live?'},
        )
      )?.value);
  if (!parameter && persistent === undefined) {
    return;
  }
  if (workflow !== undefined && persistent === undefined) {
    return;
  }
  await createEntity(
    host,
    subroutine,
    parameter ? 'session_parameters' : 'sessions',
    `Added session ${name.trim()}`,
    (project, at) =>
      workflow === undefined
        ? mutate.addAgentSession(project, at, name, parameter, persistent)
        : mutate.addWorkflowSession(project, workflow, name, persistent!),
    navigationRevision,
    workflow,
  );
}

async function chooseEnds(
  host: OpenHost,
  given?: {source?: string; target?: string; subroutine?: string},
): Promise<{source: string; target: string; subroutine: string} | undefined> {
  const subroutine = given?.subroutine ?? (await chooseSubroutine(host));
  if (subroutine === undefined) {
    return undefined;
  }
  const nodes = entities(host, subroutine, 'nodes').map(node => ({
    id: String(node.id),
    kind: node.kind as NodeKind,
  }));
  const sources = nodes.filter(
    ({kind}) => kind !== 'exit' && kind !== 'failure',
  );
  if (sources.length === 0) {
    void vscode.window.showInformationMessage(
      'This subroutine has no node that can start an edge.',
    );
    return undefined;
  }
  const sourceId =
    given?.source ??
    (await vscode.window.showQuickPick(
      sources.map(({id}) => id),
      {title: 'From which node?'},
    ));
  const source = nodes.find(({id}) => id === sourceId);
  if (source === undefined) {
    return undefined;
  }
  const targets = nodes.filter(
    ({kind}) => edgeDirectionProblem(source.kind, kind) === undefined,
  );
  const target =
    given?.target ??
    (await vscode.window.showQuickPick(
      targets.map(({id}) => id),
      {title: `From ${source.id} to which node?`},
    ));
  if (target === undefined) {
    return undefined;
  }
  return {source: source.id, subroutine, target};
}

async function chooseEdge(
  host: OpenHost,
  subroutine: string,
): Promise<string | undefined> {
  const items = entities(host, subroutine, 'edges').map(edge => ({
    description: `${String(edge.source)} → ${String(edge.target)}`,
    label: String(edge.id),
  }));
  if (items.length === 0) {
    void vscode.window.showInformationMessage(
      'This subroutine has no edges to constrain.',
    );
    return undefined;
  }
  return (await vscode.window.showQuickPick(items, {title: 'Which edge?'}))
    ?.label;
}

async function connectNodes(
  host: OpenHost,
  given?: {source?: string; target?: string; subroutine?: string},
): Promise<void> {
  const navigationRevision = host.navigationRevision;
  const pair = await chooseEnds(host, given);
  if (pair === undefined) {
    return;
  }
  await createEntity(
    host,
    pair.subroutine,
    'edges',
    `Connected ${pair.source} to ${pair.target}`,
    (project, at) => mutate.connect(project, at, pair.source, pair.target),
    navigationRevision,
  );
}

async function chooseRelinkEndpoint(
  host: OpenHost,
  subroutine: string,
  id: string,
  endpoint: 'source' | 'target',
): Promise<void> {
  const edge = entities(host, subroutine, 'edges').find(item => item.id === id);
  if (edge === undefined) {
    return;
  }
  const nodes = entities(host, subroutine, 'nodes');
  const fixed = nodes.find(
    node => node.id === edge[endpoint === 'source' ? 'target' : 'source'],
  );
  if (fixed === undefined) {
    return;
  }
  const choices = nodes
    .filter(
      node =>
        edgeDirectionProblem(
          (endpoint === 'source' ? node : fixed).kind as NodeKind,
          (endpoint === 'target' ? node : fixed).kind as NodeKind,
        ) === undefined,
    )
    .map(node => ({
      label: String(node.id),
      description: node.id === edge[endpoint] ? 'current' : undefined,
    }));
  const chosen = await vscode.window.showQuickPick(choices, {
    title: `Change ${endpoint} of ${id}`,
  });
  if (chosen === undefined || chosen.label === edge[endpoint]) {
    return;
  }
  await relinkEdge(
    host,
    subroutine,
    id,
    endpoint === 'source' ? chosen.label : String(edge.source),
    endpoint === 'target' ? chosen.label : String(edge.target),
  );
}

function subroutineFeatures(host: OpenHost, subroutineId: string): Feature[] {
  return featuresIn(
    projectOf(host, subroutineId),
    locate(host, subroutineId).subroutine,
  );
}

async function clearConstraint(
  host: OpenHost,
  subroutineId: string,
  edgeId: string,
  collection: 'conditions' | 'effects',
  featureId: string,
): Promise<boolean> {
  return editSubroutine(
    host,
    subroutineId,
    `Cleared ${featureId} on ${edgeId}`,
    (project, at) => ({
      project: mutate.unconstrain(project, at, edgeId, collection, featureId),
    }),
  );
}

async function constrainEdge(
  host: OpenHost,
  subroutineId: string,
  edgeId: string,
): Promise<boolean> {
  const found = subroutineFeatures(host, subroutineId);
  if (found.length === 0) {
    void vscode.window.showInformationMessage(
      `${subroutineId} declares no features yet. Add one first: an edge can only constrain a feature.`,
    );
    return false;
  }
  const selected = await vscode.window.showQuickPick(
    found.map(item => ({
      description: `${item.kind} · ${item.label}`,
      feature: item,
      label: item.id,
    })),
    {title: `Constrain ${edgeId} on which feature?`},
  );
  if (selected === undefined) {
    return false;
  }
  const feature = selected.feature;
  const kind = feature.kind;
  const edge = entities(host, subroutineId, 'edges').find(
    item => item.id === edgeId,
  );
  const source = entities(host, subroutineId, 'nodes').find(
    item => item.id === edge?.source,
  );
  let collection: 'conditions' | 'effects' = 'conditions';
  if (source?.kind === 'feature') {
    const side = await vscode.window.showQuickPick(
      [
        {
          description: 'what must hold for this edge to be taken',
          label: 'conditions',
        },
        {
          description: 'what must hold between pre-node and candidate states',
          label: 'effects',
        },
      ] as const,
      {title: 'A condition, or an effect?'},
    );
    if (side === undefined) {
      return false;
    }
    collection = side.label;
  }
  const observation = await vscode.window.showQuickPick(
    observationsFor(collection, kind).map(value => ({
      description: EXPLANATIONS[value] ?? '',
      label: value,
    })),
    {title: `${feature.id} (${kind}) — which observation?`},
  );
  if (observation === undefined) {
    return false;
  }
  let value: string | undefined;
  if (feature.kind === 'enum' && observation.label === 'equal') {
    value = await vscode.window.showQuickPick(feature.values, {
      title: `${feature.id} equals which value?`,
    });
    if (value === undefined) {
      return false;
    }
  }
  return editSubroutine(
    host,
    subroutineId,
    `${edgeId}: ${feature.id} ${observation.label}${value === undefined ? '' : ` ${value}`} (${collection})`,
    (project, at) => ({
      project: mutate.constrain(
        project,
        at,
        edgeId,
        collection,
        feature.id,
        observation.label,
        value,
      ),
    }),
  );
}

async function renameEntity(
  host: OpenHost,
  subroutineId: string,
  entity: mutate.Entity,
  from: string,
  to: string,
): Promise<boolean> {
  if (!isEditable(host)) {
    void vscode.window.showWarningMessage('Verdog: this project is read-only.');
    return false;
  }
  const at = locate(host, subroutineId);
  const kind =
    entity === 'subroutines' || entity === 'workflows'
      ? DEFINITION_KIND[entity]
      : entity.slice(0, -1);
  const args = [
    'rename',
    kind,
    from,
    to,
    ...(entity === 'workflows' || entity === 'subroutines'
      ? []
      : ['--subroutine', at.subroutine]),
  ];
  const outcome = await runVerdogCommand(at.root, args, {
    output: host.output,
    progress: {
      location: vscode.ProgressLocation.Window,
      title: `verdog rename ${from} → ${to}`,
    },
    trust: 'required',
  });
  if (outcome === undefined) {
    return false;
  }
  if (outcome.code !== 0) {
    void vscode.window.showWarningMessage(
      `Verdog: ${from} could not be renamed to ${to}. See the Verdog output for why.`,
    );
    return false;
  }
  await refresh(host);
  return true;
}

let activeRemovalReview: vscode.WebviewPanel | undefined;
let removalInProgress = false;

async function confirmRemoval(
  host: OpenHost,
  originSubroutine: string,
  entity: mutate.Entity,
  id: string,
  removal: ReturnType<typeof mutate.remove>,
): Promise<boolean> {
  const verb = removal.reset === true ? 'Reset' : 'Delete';
  const panel = vscode.window.createWebviewPanel(
    'verdog.removalReview',
    `${verb} ${entityLabel(entity)} ${id}`,
    {preserveFocus: false, viewColumn: vscode.ViewColumn.Active},
    {
      enableFindWidget: true,
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(host.extension, 'dist')],
      retainContextWhenHidden: false,
    },
  );
  activeRemovalReview = panel;
  const review: HostToRemovalReview = {
    kind: 'review',
    review: {
      hasAuthoredCode: removal.code.length > 0,
      impacts: removal.impacts,
      orphaned: removal.orphaned,
      reset: removal.reset === true,
      subject: {entity, id, label: entityLabel(entity)},
    },
  };
  const snapshot = host.snapshot;
  const links =
    snapshot === undefined
      ? []
      : removal.impacts.map(impact =>
          removalNavigationEntry(snapshot, originSubroutine, impact),
        );

  return await new Promise<boolean>(resolve => {
    let settled = false;
    const settle = (approved: boolean, dispose: boolean): void => {
      if (settled) {
        return;
      }
      settled = true;
      if (activeRemovalReview === panel) {
        activeRemovalReview = undefined;
      }
      if (dispose) {
        panel.dispose();
      }
      resolve(approved);
    };
    panel.onDidDispose(() => settle(false, false));
    panel.webview.onDidReceiveMessage((message: unknown) => {
      if (!isRemovalReviewToHost(message)) {
        return;
      }
      const kind = message.kind;
      if (kind === 'ready') {
        void panel.webview.postMessage(review);
      } else if (kind === 'cancel') {
        settle(false, true);
      } else if (kind === 'delete') {
        settle(true, true);
      } else if (
        (kind === 'open' || kind === 'reveal') &&
        'index' in message &&
        Number.isInteger(message.index) &&
        message.index >= 0
      ) {
        const entry = links[message.index];
        if (entry !== undefined) {
          void followNavigation(host, entry, kind === 'open');
        }
      }
    });
    panel.webview.html = webviewHtml(
      panel.webview,
      host.extension,
      'removalReview',
    );
  });
}

async function relinkEdge(
  host: OpenHost,
  subroutine: string,
  edge: string,
  source: string,
  target: string,
): Promise<void> {
  await editSubroutine(
    host,
    subroutine,
    `Relinked ${edge}: ${source} → ${target}`,
    async (project, at) => {
      const dry = mutate.relink(project, at, edge, source, target);
      let implementation: 'fresh' | 'move' = 'move';
      if (
        dry.oldImplementation !== undefined &&
        dry.oldImplementation !== dry.newImplementation
      ) {
        if (dry.newImplementation === undefined) {
          const answer = await vscode.window.showWarningMessage(
            `Relink ${edge} to ${target}?`,
            {
              detail:
                `${dry.oldImplementation} no longer belongs to the edge and will be deleted. ` +
                'It will be moved to the OS trash.',
              modal: true,
            },
            'Delete implementation and relink',
            'Cancel',
          );
          if (answer !== 'Delete implementation and relink') {
            return undefined;
          }
          implementation = 'fresh';
        } else {
          const answer = await vscode.window.showWarningMessage(
            `Relink ${edge} to ${target}?`,
            {
              detail:
                `Its implementation moves from ${dry.oldImplementation} to ` +
                `${dry.newImplementation}. Start fresh instead to delete the old implementation ` +
                'to the OS trash and generate a new executable scaffold.',
              modal: true,
            },
            'Move implementation and relink',
            'Start fresh and delete old',
            'Cancel',
          );
          if (answer === 'Move implementation and relink') {
            implementation = 'move';
          } else if (answer === 'Start fresh and delete old') {
            implementation = 'fresh';
          } else {
            return undefined;
          }
        }
      }
      const result = mutate.relink(
        project,
        at,
        edge,
        source,
        target,
        implementation,
      );
      return {files: result.files, project: result.project};
    },
  );
}

async function undoImports(
  host: OpenHost,
  root: string,
  aliases: string[],
): Promise<void> {
  for (const alias of aliases) {
    const result = await runVerdogCommand(root, ['drop', alias], {
      output: host.output,
      trust: 'required',
    });
    if (result === undefined) {
      return;
    }
    if (result.code !== 0) {
      void vscode.window.showWarningMessage(
        `verdog drop ${alias} failed, so the pin is still there. See the Verdog output.`,
      );
      return;
    }
  }
  await refresh(host);
}

async function removeEntity(
  host: OpenHost,
  subroutine: string,
  entity: mutate.Entity,
  id: string,
  workflow?: GraphId,
): Promise<void> {
  if (removalInProgress) {
    activeRemovalReview?.reveal(vscode.ViewColumn.Active);
    void vscode.window.showInformationMessage(
      'Finish the current deletion first.',
    );
    return;
  }
  removalInProgress = true;
  const location = locate(host, subroutine);
  const root = location.root;
  const resettingRoot = entity === 'subroutines' && id === location.subroutine;
  try {
    let removal: {orphaned: string[]} = {orphaned: []};
    const edited = await editSubroutine(
      host,
      subroutine,
      `${resettingRoot ? 'Reset' : 'Deleted'} ${entityLabel(entity)} ${id}`,
      async (project, at) => {
        const result = mutate.remove(project, at, entity, id, workflow);
        if (!(await confirmRemoval(host, subroutine, entity, id, result))) {
          return undefined;
        }
        removal = {
          orphaned: result.orphaned,
        };
        const deleted = result.impacts.filter(
          ({effect}) => effect === 'delete',
        ).length;
        return {
          files: result.code.map(path => ({kind: 'delete' as const, path})),
          project: result.project,
          report: `${deleted} ${deleted === 1 ? 'identity' : 'identities'}`,
        };
      },
    );
    if (edited && removal.orphaned.length > 0) {
      await undoImports(host, root, removal.orphaned);
    }
  } finally {
    removalInProgress = false;
  }
}

async function deleteViaPalette(host: OpenHost): Promise<void> {
  const subroutine = await chooseSubroutine(host);
  if (subroutine === undefined) {
    return;
  }
  const graph =
    host.snapshot === undefined
      ? undefined
      : (subroutineIn(host.snapshot, subroutine) as unknown as
          Record<string, unknown> | undefined);
  if (graph === undefined) {
    return;
  }
  const project = projectOf(host, subroutine);
  const index = definitionIndex(project);
  const owner = locate(host, subroutine).subroutine;
  const ports = new Set(
    Object.values(
      graph.ports && typeof graph.ports === 'object'
        ? (graph.ports as Record<string, unknown>)
        : {},
    ).map(String),
  );
  const choices: Array<{
    description: string;
    entity: mutate.Entity;
    label: string;
  }> = [];
  for (const entity of [
    'nodes',
    'workflows',
    'subroutines',
    'edges',
    'features',
    'profile_parameters',
    'profiles',
    'session_parameters',
    'sessions',
  ] as const) {
    for (const raw of Array.isArray(graph[entity])
      ? (graph[entity] as unknown[])
      : []) {
      const item = raw as Record<string, unknown>;
      const localId =
        entity === 'workflows'
          ? workflowId(item)
          : typeof item.id === 'string'
            ? item.id
            : undefined;
      const definition =
        localId !== undefined &&
        (entity === 'workflows' || entity === 'subroutines')
          ? [...index.definitions.values()].find(
              candidate =>
                candidate.kind === DEFINITION_KIND[entity] &&
                candidate.declaredIn === owner &&
                candidate.localId === localId,
            )
          : undefined;
      const id = definition?.id ?? localId;
      if (id === undefined) {
        continue;
      }
      if (entity === 'nodes' && ports.has(id)) {
        continue;
      }
      choices.push({
        description:
          entity === 'edges'
            ? `edge ${String(item.source)} → ${String(item.target)}`
            : `${entityLabel(entity)} · ${definition?.name ?? String(item.name ?? item.label ?? '')}`,
        entity,
        label: id,
      });
    }
  }
  const chosen = await vscode.window.showQuickPick(choices, {
    title: `Delete what from ${subroutine}?`,
  });
  if (chosen === undefined) {
    return;
  }
  await removeEntity(host, subroutine, chosen.entity, chosen.label);
}

export async function handleCanvasAction(
  host: OpenHost,
  message: CanvasAction & {subroutine: string},
): Promise<boolean | void> {
  if (!isEditable(host)) {
    void vscode.window.showWarningMessage('Verdog: this project is read-only.');
    return;
  }
  switch (message.kind) {
    case 'add-call':
      await addCallHere(host, message.subroutine);
      return;
    case 'add-definition':
      await addDefinitionHere(host, message.subroutine);
      return;
    case 'add-node':
      await addNodeHere(host, message.subroutine);
      return;
    case 'add-feature':
      await addFeatureHere(host, message.subroutine);
      return;
    case 'add-profile':
      await addProfileHere(
        host,
        message.subroutine,
        undefined,
        message.workflow,
      );
      return;
    case 'add-session':
      await addSessionHere(
        host,
        message.subroutine,
        undefined,
        message.workflow,
      );
      return;
    case 'connect':
      await connectNodes(host, message);
      return;
    case 'constrain':
      return constrainEdge(host, message.subroutine, message.edge);
    case 'unconstrain':
      return clearConstraint(
        host,
        message.subroutine,
        message.edge,
        message.collection,
        message.feature,
      );
    case 'relink':
      await relinkEdge(
        host,
        message.subroutine,
        message.edge,
        message.source,
        message.target,
      );
      return;
    case 'relink-endpoint':
      await chooseRelinkEndpoint(
        host,
        message.subroutine,
        message.edge,
        message.endpoint,
      );
      return;
    case 'set-profile-configuration':
      return editSubroutine(
        host,
        message.subroutine,
        `${message.profile}: ${message.provider} profile`,
        (project, at) => ({
          project: mutate.setProfileConfiguration(
            project,
            at,
            message.profile,
            message.provider,
            message.options,
            message.workflow,
          ),
        }),
      );
    case 'set-session-persistence':
      return editSubroutine(
        host,
        message.subroutine,
        `${message.session}: ${message.persistent ? 'persistent' : 'fresh'} session`,
        (project, at) => ({
          project: mutate.setSessionPersistence(
            project,
            at,
            message.session,
            message.persistent,
            message.workflow,
          ),
        }),
      );
    case 'set-node-resources': {
      const snapshot = host.snapshot;
      if (snapshot === undefined) {
        void vscode.window.showWarningMessage(
          'Verdog: the project is not ready.',
        );
        return;
      }
      return editSubroutine(
        host,
        message.subroutine,
        `${message.node}: resources`,
        project => {
          const {ownerPath} = subroutineAddress(
            snapshot.pinned,
            message.subroutine,
          );
          const fresh = (ownerPath === undefined
            ? {...snapshot, project}
            : {
                ...snapshot,
                pinned: {...snapshot.pinned, [ownerPath]: project},
              }) as unknown as ProjectGraphs;
          return {
            project: mutate.setNodeResources(
              fresh,
              message.subroutine,
              message.node,
              message.resources,
            ),
          };
        },
      );
    }
    case 'set-workflow-resources': {
      return editSubroutine(
        host,
        message.subroutine,
        `${message.workflow}: resources`,
        project => ({
          project: mutate.setWorkflowResources(
            project,
            message.workflow,
            message.resources,
          ),
        }),
      );
    }
    case 'name':
      return editSubroutine(
        host,
        message.subroutine,
        `Named ${message.entity.slice(0, -1)} ${message.id} "${message.name}"`,
        (project, at) => ({
          project: mutate.setName(
            project,
            at,
            message.entity,
            message.id,
            message.name,
            message.workflow,
          ),
        }),
      );
    case 'rename':
      return renameEntity(
        host,
        message.subroutine,
        message.entity,
        message.id,
        message.to,
      );
    case 'remove': {
      await removeEntity(
        host,
        message.subroutine,
        message.entity,
        message.id,
        message.workflow,
      );
      return;
    }
    default: {
      const exhaustive: never = message;
      return exhaustive;
    }
  }
}

export function registerProjectCommands(host: OpenHost): vscode.Disposable[] {
  return [
    authoring.register(),
    vscode.commands.registerCommand('verdog.check', () =>
      runVerb(
        host,
        host.showingSubroutine === undefined
          ? host.root
          : locate(host, host.showingSubroutine).root,
        'check',
      ),
    ),
    vscode.commands.registerCommand('verdog.run', () =>
      runVerb(
        host,
        host.showingSubroutine === undefined
          ? host.root
          : locate(host, host.showingSubroutine).root,
        'run',
      ),
    ),
    vscode.commands.registerCommand(
      'verdog.addNode',
      (given?: {
        detail?: string;
        kind?: string;
        name?: string;
        profile?: string;
        session?: string;
        subroutine?: string;
      }) => addNodeHere(host, given?.subroutine, given),
    ),
    vscode.commands.registerCommand(
      'verdog.addDefinition',
      (given?: {
        kind?: string;
        name?: string;
        subroutine?: string;
        target?: string;
      }) => addDefinitionHere(host, given?.subroutine, given),
    ),
    vscode.commands.registerCommand(
      'verdog.addCall',
      (given?: {
        kind?: string;
        name?: string;
        target?: string;
        subroutine?: string;
      }) => addCallHere(host, given?.subroutine, given),
    ),
    vscode.commands.registerCommand(
      'verdog.addFeature',
      (given?: {
        description?: string;
        kind?: string;
        label?: string;
        subroutine?: string;
        values?: string[];
      }) => addFeatureHere(host, given?.subroutine, given),
    ),
    vscode.commands.registerCommand(
      'verdog.addProfile',
      (given?: {name?: string; parameter?: boolean; subroutine?: string}) =>
        addProfileHere(host, given?.subroutine, given),
    ),
    vscode.commands.registerCommand(
      'verdog.addSession',
      (given?: {
        name?: string;
        parameter?: boolean;
        persistent?: boolean;
        subroutine?: string;
      }) => addSessionHere(host, given?.subroutine, given),
    ),
    vscode.commands.registerCommand(
      'verdog.deleteEntity',
      async (given?: {
        entity?: mutate.Entity;
        id?: string;
        subroutine?: string;
      }) => {
        if (given?.entity === undefined || given.id === undefined) {
          await deleteViaPalette(host);
          return;
        }
        const subroutine = given.subroutine ?? subroutineIds(host)[0];
        if (subroutine === undefined) {
          return;
        }
        await removeEntity(host, subroutine, given.entity, given.id);
      },
    ),
    vscode.commands.registerCommand(
      'verdog.connect',
      (given?: {source?: string; target?: string; subroutine?: string}) =>
        connectNodes(host, given),
    ),
    vscode.commands.registerCommand(
      'verdog.constrain',
      async (given?: {
        collection?: 'conditions' | 'effects';
        edge?: string;
        feature?: string;
        observation?: string;
        subroutine?: string;
        value?: string;
      }) => {
        const subroutine = given?.subroutine ?? subroutineIds(host)[0];
        if (subroutine === undefined) {
          return;
        }
        if (
          given?.edge !== undefined &&
          given.collection !== undefined &&
          given.feature !== undefined &&
          given.observation !== undefined
        ) {
          await editSubroutine(
            host,
            subroutine,
            `${given.edge}: ${given.feature} ${given.observation} (${given.collection})`,
            (project, at) => ({
              project: mutate.constrain(
                project,
                at,
                given.edge!,
                given.collection!,
                given.feature!,
                given.observation!,
                given.value,
              ),
            }),
          );
          return;
        }
        const edge = given?.edge ?? (await chooseEdge(host, subroutine));
        if (edge !== undefined) {
          await constrainEdge(host, subroutine, edge);
        }
      },
    ),
    vscode.commands.registerCommand('verdog.access', async () => {
      await readAccess(host);
      const access = host.access;
      void vscode.window.showInformationMessage(
        access === undefined
          ? 'Verdog: catalogue permissions unavailable (no remote, or the service could not be reached).'
          : !access.accessible
            ? `Verdog: your GitHub sign-in cannot access ${access.repository} in the catalogue. Local editing and compiler operations remain available.`
            : `Verdog: ${access.repository} — catalogue permissions: ${
                [access.read && 'read', access.write && 'write']
                  .filter(Boolean)
                  .join(', ') || 'none'
              }.`,
      );
    }),
  ];
}
