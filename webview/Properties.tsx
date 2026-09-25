// AGPL-3.0-only with the additional permission in LICENSE-EXCEPTION.
import { useEffect, useState } from "react";

import { defaultAgentInvokerOptions } from "../model/agents";
import { AGENT_PROVIDERS } from "../model/project";
import type { ResourceField } from "../model/resources";
import type { PropertyRequest } from "../model/protocol";
import type { EdgeConstraint, ProfileConfiguration } from "./propertyData";

/** Read and edit the inspected entity, committing fields on Enter or blur. */
export type Field = { label: string; value: string };
const resourceKey = (field: ResourceField): string =>
  `${field.resource}:${field.parameter ?? ""}`;
const CONSTRAINT_SECTIONS = [
  ["conditions", "Conditions"],
  ["effects", "Effects"],
] as const;

export function Properties({
  constraints,
  constraintsWritable,
  documents,
  fields,
  failedRequest,
  id,
  idWritable,
  kind,
  name,
  nameWritable,
  onConstrain,
  onName,
  onOpen,
  onProfile,
  onRemoveConstraint,
  onRename,
  onResources,
  onSessionPersistence,
  pending = false,
  persistent,
  profile,
  resources,
  resourcesWritable,
  settingsWritable,
}: {
  /** Authored conditions and effects, in their mathematical notation. */
  constraints?: EdgeConstraint[];
  /** Whether this edge's conditions and effects can be changed. */
  constraintsWritable: boolean;
  /** Files this entity has, offered as links rather than described. */
  documents: { label: string; path: string }[];
  /** Everything else worth reading, in reading order. */
  fields: Field[];
  failedRequest?: PropertyRequest;
  id: string;
  idWritable: boolean;
  /** `node`, `edge` or `feature`, shown as the heading. */
  kind: string;
  /** The prose label. A feature's lives in `label`; everything else calls it `name`. */
  name: string;
  nameWritable: boolean;
  onConstrain?: () => void;
  onName: (name: string) => void;
  onOpen: (path: string) => void;
  onProfile: (profile: ProfileConfiguration) => void;
  onRemoveConstraint: (
    collection: EdgeConstraint["collection"],
    feature: EdgeConstraint["feature"],
  ) => void;
  onRename: (to: string) => void;
  onResources: (fields: ResourceField[]) => void;
  onSessionPersistence: (persistent: boolean) => void;
  pending?: boolean;
  persistent?: boolean;
  profile?: ProfileConfiguration;
  resources: ResourceField[];
  resourcesWritable: boolean;
  settingsWritable: boolean;
}) {
  const [draftId, setDraftId] = useState(id);
  const [draftName, setDraftName] = useState(name);
  const [draftResources, setDraftResources] = useState<Record<string, string>>({});
  const [draftProfile, setDraftProfile] = useState(profile);
  const resourceState = resources
    .map((field) => `${resourceKey(field)}=${field.value}`)
    .join("\0");
  useEffect(() => {
    setDraftId(id);
    setDraftName(name);
  }, [id, name]);
  useEffect(() => {
    setDraftResources(Object.fromEntries(
      resources.map((field) => [resourceKey(field), field.value]),
    ));
  }, [id, resourceState]);
  const profileState = JSON.stringify(profile);
  useEffect(() => setDraftProfile(profile), [id, profileState]);
  useEffect(() => {
    if (failedRequest?.edit.kind === "rename") setDraftId(id);
    if (failedRequest?.edit.kind === "name") setDraftName(name);
  }, [failedRequest, id, name]);

  const commitId = () => {
    if (!idWritable || pending) return;
    const next = draftId.trim();
    if (next === id) return;
    if (next === "") {
      setDraftId(id);
      return;
    }
    onRename(next);
  };
  const commitName = () => {
    if (!nameWritable || pending) return;
    const next = draftName.trim();
    if (next === name || next === "") {
      setDraftName(name);
      return;
    }
    onName(next);
  };

  return (
    <section aria-label={`${kind} properties`} className="properties">
      <p className="kind">{kind}</p>
      <fieldset aria-busy={pending} className="property-fields" disabled={pending}>
        <dl>
          <dt>
            <label htmlFor="property-id">id</label>
          </dt>
          <dd>
            <input
              disabled={!idWritable}
              id="property-id"
              onBlur={commitId}
              onChange={(event) => setDraftId(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") event.currentTarget.blur();
                if (event.key === "Escape") {
                  event.preventDefault();
                  event.stopPropagation();
                  setDraftId(id);
                }
              }}
              readOnly={!idWritable}
              spellCheck={false}
              title={
                idWritable
                  ? "Renaming moves this entity's files and rewrites what refers to it. Enter to apply."
                  : "This id is derived, or this project is read-only."
              }
              value={draftId}
            />
          </dd>
          <dt>
            <label htmlFor="property-name">name</label>
          </dt>
          <dd>
            <input
              disabled={!nameWritable}
              id="property-name"
              onBlur={commitName}
              onChange={(event) => setDraftName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") event.currentTarget.blur();
                if (event.key === "Escape") {
                  event.preventDefault();
                  event.stopPropagation();
                  setDraftName(name);
                }
              }}
              title={nameWritable
                ? "Enter to apply this name."
                : "This name is derived, or this project is read-only."}
              value={draftName}
            />
          </dd>
          {fields.map((field) => (
            <div key={field.label}>
              <dt>{field.label}</dt>
              <dd className="reading">{field.value}</dd>
            </div>
          ))}
          {onConstrain !== undefined && (
            <div className="property-action">
              <dt />
              <dd>
                <button
                  disabled={!constraintsWritable}
                  onClick={onConstrain}
                  title="Add or replace this edge's condition or effect"
                  type="button"
                >
                  add constraint
                </button>
              </dd>
            </div>
          )}
          {draftProfile !== undefined && (
            <>
              <div>
                <dt><label htmlFor="property-provider">provider</label></dt>
                <dd>
                  <select
                    disabled={!settingsWritable}
                    id="property-provider"
                    onChange={(event) => {
                      const provider = event.target.value as ProfileConfiguration["provider"];
                      setDraftProfile({ provider, options: defaultAgentInvokerOptions() });
                    }}
                    value={draftProfile.provider}
                  >
                    {AGENT_PROVIDERS.map((provider) => (
                      <option key={provider} value={provider}>{provider}</option>
                    ))}
                  </select>
                </dd>
              </div>
              {(["model", "reasoning_effort"] as const).map((option) => (
                <div key={option}>
                  <dt><label htmlFor={`property-profile-${option}`}>{option}</label></dt>
                  <dd>
                    <input
                      disabled={!settingsWritable}
                      id={`property-profile-${option}`}
                      onChange={(event) => setDraftProfile((current) => current === undefined
                        ? current
                        : {
                            ...current,
                            options: {
                              ...current.options,
                              [option]: event.target.value || null,
                            },
                          })}
                      placeholder={`default ${draftProfile.provider} ${option.replace("reasoning_", "")}`}
                      spellCheck={false}
                      value={draftProfile.options[option] ?? ""}
                    />
                  </dd>
                </div>
              ))}
              <div>
                <dt><label htmlFor="property-profile-web-search">web_search</label></dt>
                <dd>
                  <input
                    checked={draftProfile.options.web_search === true}
                    disabled={!settingsWritable}
                    id="property-profile-web-search"
                    onChange={(event) => setDraftProfile((current) => current === undefined
                      ? current
                      : {
                          ...current,
                          options: { ...current.options, web_search: event.target.checked },
                        })}
                    title="Let read-only agents of this profile search and fetch the web"
                    type="checkbox"
                  />
                </dd>
              </div>
              <div>
                <dt><label htmlFor="property-profile-extra-args">extra_args</label></dt>
                <dd>
                  <textarea
                    disabled={!settingsWritable}
                    id="property-profile-extra-args"
                    onChange={(event) => setDraftProfile((current) => current === undefined
                      ? current
                      : {
                          ...current,
                          options: {
                            ...current.options,
                            extra_args: event.target.value.split("\n"),
                          },
                        })}
                    placeholder="one argument per line"
                    spellCheck={false}
                    value={draftProfile.options.extra_args.join("\n")}
                  />
                </dd>
              </div>
              <div className="property-action">
                <dt />
                <dd>
                  <button
                    disabled={!settingsWritable}
                    onClick={() => onProfile({
                      ...draftProfile,
                      options: {
                        ...draftProfile.options,
                        extra_args: draftProfile.options.extra_args.filter(Boolean),
                      },
                    })}
                    title={`Apply this ${draftProfile.provider} profile configuration`}
                    type="button"
                  >
                    apply profile
                  </button>
                </dd>
              </div>
            </>
          )}
          {persistent !== undefined && (
            <div>
              <dt><label htmlFor="property-session-persistent">persistent</label></dt>
              <dd>
                <input
                  checked={persistent}
                  disabled={!settingsWritable}
                  id="property-session-persistent"
                  onChange={(event) => onSessionPersistence(event.target.checked)}
                  type="checkbox"
                />
              </dd>
            </div>
          )}
          {resources.map((field, index) => {
            const control = `property-resource-${index}`;
            const selected = draftResources[resourceKey(field)] ?? field.value;
            const hasValue = field.options.includes(selected);
            return (
              <div key={`${field.resource}-${field.parameter ?? "agent"}`}>
                <dt>
                  <label htmlFor={control}>{field.label}</label>
                </dt>
                <dd>
                  <select
                    disabled={!resourcesWritable || field.options.length === 0}
                    id={control}
                    onChange={(event) => setDraftResources((current) => ({
                      ...current,
                      [resourceKey(field)]: event.target.value,
                    }))}
                    value={selected}
                  >
                    {!hasValue && (
                      <option value={selected}>{selected || "unbound"}</option>
                    )}
                    {field.options.map((option) => (
                      <option key={option} value={option}>{option}</option>
                    ))}
                  </select>
                </dd>
              </div>
            );
          })}
          {resources.length > 0 && (
            <div className="property-action">
              <dt />
              <dd>
                <button
                  disabled={!resourcesWritable || resources.some((field) =>
                    !field.options.includes(draftResources[resourceKey(field)] ?? field.value)
                  )}
                  onClick={() => onResources(resources.map((field) => ({
                    ...field,
                    value: draftResources[resourceKey(field)] ?? field.value,
                  })))}
                  title="Apply this node's profile and session bindings together"
                  type="button"
                >
                  apply bindings
                </button>
              </dd>
            </div>
          )}
        </dl>
        {constraints !== undefined && (
          <section aria-label="Edge constraints" className="edge-constraints">
            {CONSTRAINT_SECTIONS.map(([collection, heading]) => {
              const rows = constraints.filter((constraint) => constraint.collection === collection);
              return (
                <section className="constraint-section" key={collection}>
                  <h2>{heading}</h2>
                  {rows.length === 0 ? (
                    <p className="constraint-empty">none</p>
                  ) : (
                    <ul className="constraint-list">
                      {rows.map((constraint) => (
                        <li className="constraint-row" key={constraint.feature}>
                          <code>{constraint.expression}</code>
                          <button
                            aria-label={`Remove ${collection.slice(0, -1)} ${constraint.expression}`}
                            className="delete-entry"
                            disabled={!constraintsWritable}
                            onClick={() => onRemoveConstraint(collection, constraint.feature)}
                            title={constraintsWritable
                              ? `Remove ${constraint.expression}`
                              : "This project is read-only."}
                            type="button"
                          >
                            <svg aria-hidden="true" viewBox="0 0 16 16">
                              <path d="M6 2h4l1 2h3v1H2V4h3l1-2Zm-2 4h8l-.6 8H4.6L4 6Zm2 1v6h1V7H6Zm3 0v6h1V7H9Z" />
                            </svg>
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </section>
              );
            })}
          </section>
        )}
      </fieldset>
      {pending && <p role="status">Saving…</p>}
      {documents.length > 0 && (
        <ul className="files">
          {documents.map((document) => (
            <li key={document.path}>
              <button
                onClick={() => onOpen(document.path)}
                title={document.path}
                type="button"
              >
                {document.label} ↗
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
