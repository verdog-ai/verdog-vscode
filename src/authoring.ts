// AGPL-3.0-only with the additional permission in LICENSE-EXCEPTION.
/**
 * Completion for `project.json`, so the graph can be written without memorising it.
 *
 * The thin VS Code adapter: cursor context, observation vocabulary and snippets live in
 * `model/`, where they can be tested without importing the editor.
 *
 * Three gestures, offered where an author already is when they want them:
 *
 *   * inside `nodes` / `edges` / `features`, a snippet for a new item;
 *   * on `feature_id`, the features of the enclosing subroutine, each showing its kind;
 *   * on `observation`, only the values that mean something for that feature's kind and for
 *     whether this is a condition or an effect -- vocabulary the compiler enforces and no
 *     schema can express, since the answer depends on another part of the document.
 *   * on an enum observation's `value`, only the values declared by that feature.
 */

import * as path from "node:path";

import * as vscode from "vscode";

import { readClone } from "./clone";

import {
  contextAt,
  documentDefinitions,
  documentFeatures,
  type Collection,
} from "../model/grammar";
import {
  EXPLANATIONS,
  observationsFor,
  type Feature,
  type ObservationCollection,
} from "../model/features";
import { snippetsFor } from "../model/snippets";
import type { CallTarget } from "../model/project";
import { externalSubroutineTargets } from "../model/snapshot";

function snippetItems(collection: Collection): vscode.CompletionItem[] {
  return snippetsFor(collection).map((snippet) => {
    const item = new vscode.CompletionItem(
      snippet.label,
      vscode.CompletionItemKind.Snippet,
    );
    item.detail = snippet.detail;
    item.documentation = new vscode.MarkdownString(snippet.documentation);
    item.insertText = new vscode.SnippetString(snippet.body);
    return item;
  });
}

function observationItems(
  collection: ObservationCollection,
  feature: Feature | undefined,
): vscode.CompletionItem[] {
  return observationsFor(collection, feature?.kind).map((value) => {
    const item = new vscode.CompletionItem(value, vscode.CompletionItemKind.EnumMember);
    item.detail = feature === undefined ? "observation" : `${feature.kind} feature`;
    item.documentation = new vscode.MarkdownString(
      EXPLANATIONS[value] ?? "An observation the compiler accepts.",
    );
    return item;
  });
}

function featureItems(found: Feature[]): vscode.CompletionItem[] {
  return found.map((feature) => {
    const item = new vscode.CompletionItem(feature.id, vscode.CompletionItemKind.Field);
    item.detail = `${feature.kind} · ${feature.label}`;
    if (feature.kind === "enum") {
      const values = feature.values.map((value) => `\`${value}\``).join(", ");
      item.documentation = new vscode.MarkdownString(
        `An enum feature of this subroutine. Its declared values are ${values || "not yet set"}. ` +
          "Conditions require one pre-node value with `equal`; effects require one candidate value with `equal`, or use " +
          "`unconstrained` to give up precision.",
      );
      return item;
    }
    const conditions = observationsFor("conditions", feature.kind)
      .map((value) => `\`${value}\``)
      .join(" or ");
    const effects = observationsFor("effects", feature.kind)
      .map((value) => `\`${value}\``)
      .join(", ");
    item.documentation = new vscode.MarkdownString(
      `A \`${feature.kind}\` feature of this subroutine. Conditions on it may be ` +
        `${conditions}; outgoing feature-node effects may be ${effects}.`,
    );
    return item;
  });
}

function valueItems(feature: Feature | undefined): vscode.CompletionItem[] | undefined {
  if (feature?.kind !== "enum") return undefined;
  return feature.values.map((value) => {
    const item = new vscode.CompletionItem(value, vscode.CompletionItemKind.EnumMember);
    item.detail = `enum value · ${feature.label}`;
    item.documentation = new vscode.MarkdownString(
      `A declared value of the \`${feature.id}\` enum feature.`,
    );
    return item;
  });
}

function definitionItems(
  text: string,
  subroutine: string | undefined,
  callKind: Parameters<typeof documentDefinitions>[2],
  external: readonly CallTarget[],
): vscode.CompletionItem[] {
  return documentDefinitions(text, subroutine, callKind, external).map((definition) => {
    const item = new vscode.CompletionItem(definition.id, vscode.CompletionItemKind.Reference);
    item.detail = `${definition.kind} · ${definition.name}`;
    const documentation = definition.externalAlias !== undefined
      ? `An external subroutine imported through \`${definition.externalAlias}\`.`
      : definition.external !== undefined
        ? `An external workflow bound through \`${definition.external.alias}\`.`
        : `A lexically visible ${definition.kind} definition.`;
    item.documentation = new vscode.MarkdownString(documentation);
    return item;
  });
}

/**
 * Register completion for `project.json`.
 *
 * Scoped by pattern rather than by language: every JSON file would otherwise be offered node
 * skeletons, and a completion list that is wrong most of the time is one people switch off.
 */
export function register(): vscode.Disposable {
  return vscode.languages.registerCompletionItemProvider(
    { language: "json", pattern: "**/project.json", scheme: "file" },
    {
      async provideCompletionItems(document, position) {
        const text = document.getText();
        const offset = document.offsetAt(position);
        const context = contextAt(text, offset);
        if (context.collection === undefined) return undefined;

        if (context.property === "observation") {
          if (context.collection !== "conditions" && context.collection !== "effects") {
            return undefined;
          }
          const found = documentFeatures(text, context.subroutine);
          return observationItems(
            context.collection,
            found.find((item) => item.id === context.feature),
          );
        }
        if (context.property === "value") {
          if (context.collection !== "conditions" && context.collection !== "effects") {
            return undefined;
          }
          const found = documentFeatures(text, context.subroutine);
          return valueItems(found.find((item) => item.id === context.feature));
        }
        if (context.property === "feature_id") {
          if (context.collection !== "conditions" && context.collection !== "effects") {
            return undefined;
          }
          return featureItems(documentFeatures(text, context.subroutine));
        }
        if (context.property === "target") {
          let external: CallTarget[] = [];
          if (context.callKind === "subroutine_call" && context.subroutine !== undefined) {
            try {
              const snapshot = await readClone(path.dirname(document.uri.fsPath));
              external = externalSubroutineTargets(snapshot, context.subroutine);
            } catch {
              // The document may be half-written; local completion still works.
            }
          }
          return definitionItems(text, context.subroutine, context.callKind, external);
        }
        return context.insertion ? snippetItems(context.collection) : undefined;
      },
    },
    // Quotes start value completion; `[` and `,` start a complete new array item.
    '"',
    "[",
    ",",
  );
}
