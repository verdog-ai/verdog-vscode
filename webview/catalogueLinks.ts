// AGPL-3.0-only with the additional permission in LICENSE-EXCEPTION.
/** Resolve README links without granting a publisher command/file URI authority. */
export function documentationHref(
  href: string,
  repository: string,
  commit: string,
  readmePath: string,
): string | undefined {
  try {
    const absolute = new URL(href);
    return absolute.protocol === "https:" ? absolute.toString() : undefined;
  } catch {
    if (href.startsWith("#")) return href;
    const root = `https://github.com/${repository}/blob/${commit}/`;
    const resolved = new URL(href, new URL(readmePath, root));
    return resolved.origin === "https://github.com" && resolved.href.startsWith(root)
      ? resolved.toString()
      : undefined;
  }
}
