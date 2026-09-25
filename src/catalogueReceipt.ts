// AGPL-3.0-only with the additional permission in LICENSE-EXCEPTION.
export type CatalogueImportReceipt = {
  alias: string;
  binding: string;
  commit: string;
  generated_status: number;
  package: string;
  repository: string;
  target: string;
  workflow_id: string;
};

export type ReviewedCatalogueImport = {
  alias: string;
  commit: string;
  into: string;
  package: string;
  repository: string;
  workflow_id: string;
};

/** Parse the one success envelope that means an import binding now exists. */
export function decodeCatalogueImportReceipt(stdout: string): CatalogueImportReceipt | undefined {
  try {
    const value = JSON.parse(stdout) as Record<string, unknown>;
    const stringFields = [
      "alias",
      "binding",
      "commit",
      "package",
      "repository",
      "target",
      "workflow_id",
    ] as const;
    if (
      value.status !== "imported" ||
      !stringFields.every((key) => typeof value[key] === "string" && value[key] !== "") ||
      typeof value.generated_status !== "number" ||
      !Number.isSafeInteger(value.generated_status) ||
      value.generated_status < 0
    ) return undefined;
    return {
      alias: value.alias as string,
      binding: value.binding as string,
      commit: value.commit as string,
      generated_status: value.generated_status,
      package: value.package as string,
      repository: value.repository as string,
      target: value.target as string,
      workflow_id: value.workflow_id as string,
    };
  } catch {
    return undefined;
  }
}

function bindingMatches(binding: string, into: string, workflow: string): boolean {
  const leaf = workflow.split("__").at(-1);
  if (leaf === undefined || leaf === "") return false;
  const base = `${into}__${leaf}`;
  if (binding === base) return true;
  if (!binding.startsWith(`${base}_`)) return false;
  const suffix = binding.slice(base.length + 1);
  return /^(?:[2-9]|[1-9][0-9]{1,2})$/.test(suffix) && Number(suffix) <= 999;
}

/** Verify that a receipt names precisely the import the reader reviewed. */
export function catalogueImportReceiptMatches(
  receipt: CatalogueImportReceipt,
  reviewed: ReviewedCatalogueImport,
): boolean {
  return receipt.repository.toLowerCase() === reviewed.repository.toLowerCase() &&
    receipt.commit === reviewed.commit &&
    receipt.workflow_id === reviewed.workflow_id &&
    receipt.package === reviewed.package &&
    receipt.alias === reviewed.alias &&
    receipt.target === `external/${reviewed.alias.replaceAll(".", "/")}` &&
    bindingMatches(receipt.binding, reviewed.into, reviewed.workflow_id);
}
