/** Every file a packed extension's manifest asks Chrome to load, and whether the archive holds them.
 *
 *  `install.sh` verifies the download by its own CRCs, which is exact and needs no parser. Knowing
 *  which *files* a manifest names needs one, and a shell has none it can count on — so the
 *  completeness question lives here, where `JSON.parse` does. It is one implementation on purpose:
 *  the check that gates the commit (`check:zip`, run again by `package.yml` before it pushes) and
 *  the check that looks at what the site actually serves (`smoke:web`) have to be able to disagree
 *  about the archive, and can never disagree about what a manifest means.
 *
 *  Placement was the whole of finding #30. `smoke:web` runs after `package.yml` has committed and
 *  pushed, so a build whose manifest names a `background.js` that is not in the zip passes `unzip
 *  -t`, ships, and takes somebody's working copy with it when they update. Going red afterwards
 *  neither stops the publish nor gives them their extension back. */
import { execFileSync } from 'node:child_process';

/** Called with each problem. Both callers already have somewhere to put one — a collected list, a
 *  failure count — and neither wants this module deciding which is fatal. */
export type Warn = (problem: string) => void;

/** Every file the manifest asks Chrome to load, extension-root-relative.
 *
 *  Field-aware, because a scan for path-shaped strings is wrong in both directions on manifests
 *  Chrome accepts. It claims things that are not files — a `short_name` of `House.hunt` — and it
 *  misses things that are: a path with a space in it, or one written `content-scripts\/panel.js`,
 *  which is legal JSON for the same path and which a text scan looks up with the backslash still in
 *  place. `JSON.parse` settles the escapes, and reading named fields settles the rest.
 *
 *  A manifest carrying a key this does not know about is reported rather than being checked in
 *  part. That is the whole point of the finding this answers: a parser that silently covers less
 *  than it claims reports a green tick about the half it looked at. Adding a field here is a
 *  deliberate act, and the warning tells you which field to add. */
export function referencedPaths(manifest: Record<string, unknown>, warn: Warn): string[] {
  /** Top-level manifest keys that hold no path, so finding one is not a reason to stop. Anything not
   *  here and not read below is a key this parser has never seen, which is the case it must refuse:
   *  a new field holding a filename would otherwise be checked by not being checked. */
  const pathless = new Set([
    'manifest_version', 'name', 'short_name', 'description', 'version', 'version_name', 'key',
    'permissions', 'optional_permissions', 'host_permissions', 'optional_host_permissions',
    'content_security_policy', 'externally_connectable', 'incognito', 'minimum_chrome_version',
    'offline_enabled', 'update_url', 'homepage_url', 'author', 'omnibox', 'commands',
    'cross_origin_embedder_policy', 'cross_origin_opener_policy',
  ]);
  const found: string[] = [];
  const add = (value: unknown, where: string): void => {
    if (typeof value !== 'string') {
      warn(`the manifest's ${where} is not a string — this check cannot read that shape`);
      return;
    }
    found.push(value.replace(/^\//, ''));
  };

  for (const [key, value] of Object.entries(manifest)) {
    if (pathless.has(key)) continue;
    switch (key) {
      case 'background': {
        const background = value as Record<string, unknown>;
        if ('service_worker' in background) add(background.service_worker, 'background.service_worker');
        for (const [i, script] of ((background.scripts as unknown[]) ?? []).entries()) add(script, `background.scripts[${i}]`);
        break;
      }
      case 'content_scripts':
        for (const [i, entry] of (value as Record<string, unknown>[]).entries()) {
          for (const kind of ['js', 'css'] as const) {
            for (const [j, path] of ((entry[kind] as unknown[]) ?? []).entries()) add(path, `content_scripts[${i}].${kind}[${j}]`);
          }
        }
        break;
      case 'icons':
        for (const [size, path] of Object.entries(value as Record<string, unknown>)) add(path, `icons["${size}"]`);
        break;
      case 'action':
      case 'browser_action':
      case 'page_action': {
        const action = value as Record<string, unknown>;
        if ('default_popup' in action) add(action.default_popup, `${key}.default_popup`);
        if (typeof action.default_icon === 'string') add(action.default_icon, `${key}.default_icon`);
        else if (action.default_icon) {
          for (const [size, path] of Object.entries(action.default_icon as Record<string, unknown>)) add(path, `${key}.default_icon["${size}"]`);
        }
        break;
      }
      case 'web_accessible_resources':
        for (const [i, entry] of (value as Record<string, unknown>[]).entries()) {
          for (const [j, path] of ((entry.resources as unknown[]) ?? []).entries()) add(path, `web_accessible_resources[${i}].resources[${j}]`);
        }
        break;
      case 'default_locale':
        // Not a path itself; it is the one field that names a file only by implication, and the
        // file it implies is the one whose absence breaks every `__MSG_` in the manifest.
        add(`_locales/${String(value)}/messages.json`, 'default_locale');
        break;
      case 'options_page':
        add(value, 'options_page');
        break;
      case 'options_ui':
        add((value as Record<string, unknown>).page, 'options_ui.page');
        break;
      case 'side_panel':
        add((value as Record<string, unknown>).default_path, 'side_panel.default_path');
        break;
      case 'devtools_page':
        add(value, 'devtools_page');
        break;
      case 'chrome_url_overrides':
        for (const [page, path] of Object.entries(value as Record<string, unknown>)) add(path, `chrome_url_overrides.${page}`);
        break;
      case 'declarative_net_request':
        for (const [i, rule] of (((value as Record<string, unknown>).rule_resources as Record<string, unknown>[]) ?? []).entries()) {
          add(rule.path, `declarative_net_request.rule_resources[${i}].path`);
        }
        break;
      case 'storage':
        add((value as Record<string, unknown>).managed_schema, 'storage.managed_schema');
        break;
      case 'sandbox':
        for (const [i, path] of (((value as Record<string, unknown>).pages as unknown[]) ?? []).entries()) add(path, `sandbox.pages[${i}]`);
        break;
      default:
        warn(`the manifest has a "${key}" this check does not know how to read — it may name files that nothing is verifying (add it to referencedPaths)`);
    }
  }
  return [...new Set(found)];
}

/** Chrome allows a glob in `web_accessible_resources`, so a literal lookup would report a pattern
 *  as missing. Matched rather than resolved: `*` spans path separators there, and the only question
 *  is whether the archive holds anything the pattern would serve. */
export function matchesAny(pattern: string, names: Set<string>): boolean {
  const rx = new RegExp(`^${pattern.split('*').map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);
  return [...names].some((name) => rx.test(name));
}

/** What a zip on disk holds, by name. Directory entries are dropped — they hold nothing, and no
 *  manifest field names one. */
export function archiveEntries(zip: string): Set<string> {
  return new Set(
    execFileSync('unzip', ['-Z1', zip], { encoding: 'utf8' })
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line && !line.endsWith('/')),
  );
}

/** The completeness check itself: every path the archive's own manifest names is in the archive.
 *  Returns what was asked for as well as what is missing, because "0 missing" out of nothing
 *  referenced is the other way this passes while being wrong. */
export function checkArchiveIsComplete(zip: string, warn: Warn): { refs: string[]; missing: string[] } {
  const names = archiveEntries(zip);
  if (!names.has('manifest.json')) {
    warn('the archive has no manifest.json — Chrome would refuse to load it');
    return { refs: [], missing: [] };
  }
  const manifest = JSON.parse(execFileSync('unzip', ['-p', zip, 'manifest.json'], { encoding: 'utf8' }));
  const refs = referencedPaths(manifest, warn);
  if (refs.length === 0) warn("the archive's manifest.json asks Chrome to load nothing at all");
  const missing = refs.filter((ref) => (ref.includes('*') ? !matchesAny(ref, names) : !names.has(ref)));
  for (const ref of missing) warn(`the archive's manifest.json asks Chrome to load ${ref}, which is not in it`);
  return { refs, missing };
}
