import type { DeliveryVersion } from '../contracts/versions.ts';
/** Locate the captured file, including when the material root is nested below a source root. */
export function versionReports(version: Pick<DeliveryVersion, 'reportPaths' | 'snapshot'>) {
  return versionFileReferences(version, version.reportPaths);
}
export function versionFileReferences(version: Pick<DeliveryVersion, 'snapshot'>, paths: string[]) {
  return paths.map((absolute) => {
    const normalized = absolute.replaceAll('\\', '/');
    const absolutePath = /^(?:\/|[a-z]:\/)/i.test(normalized),
      matches: { rootIndex: number; path: string }[] = [];
    for (let rootIndex = 0; rootIndex < version.snapshot.roots.length; rootIndex++) {
      const root = version.snapshot.roots[rootIndex]!;
      const prefix = root.root.replaceAll('\\', '/').replace(/\/$/, '') + '/';
      if (absolutePath && !normalized.toLowerCase().startsWith(prefix.toLowerCase())) continue;
      const path = absolutePath ? normalized.slice(prefix.length) : normalized.replace(/^\.\//, '');
      if (root.files.some((file) => file.path === path)) matches.push({ rootIndex, path });
    }
    if (matches.length === 1) return { absolute, ...matches[0]!, available: true as const };
    return { absolute, rootIndex: null, path: null, available: false as const };
  });
}
