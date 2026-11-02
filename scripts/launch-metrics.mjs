// Manual aggregate snapshots only. Uses existing gh authentication; never reads app credentials.
import { execFileSync } from 'node:child_process';
import console from 'node:console';
import { writeFileSync } from 'node:fs';
import process from 'node:process';

const repository = 'energee/appletv-desktop-remote';
const apiRoot = `repos/${repository}`;
const usage = `Usage: node scripts/launch-metrics.mjs [--traffic] [--output NEW_FILE]

Print a timestamped aggregate GitHub snapshot as JSON.
--traffic          Include access-restricted rolling views/clones aggregates.
--output NEW_FILE  Also save the same JSON to a new file (never overwrite).
Requires Node.js 24 and an already-authenticated gh CLI for github.com.`;

class CollectionError extends Error {
  constructor(message, httpStatus = null) {
    super(message);
    this.httpStatus = httpStatus;
  }
}

function parseOptions(args) {
  const options = { traffic: false, output: null, help: false };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--traffic') {
      options.traffic = true;
    } else if (argument === '--output') {
      const filename = args[index + 1];
      if (!filename || filename.startsWith('--') || options.output !== null) {
        throw new CollectionError('Supply --output once, followed by a new file path.');
      }
      options.output = filename;
      index += 1;
    } else if (argument === '--help' || argument === '-h') {
      options.help = true;
    } else {
      throw new CollectionError('Unknown argument. Use --help for usage.');
    }
  }
  return options;
}

function api(endpoint, projection, paginate = false) {
  const resource = endpoint || 'repository metadata';
  const apiPath = endpoint ? `${apiRoot}/${endpoint}` : apiRoot;
  const args = ['api', '--hostname', 'github.com', '--method', 'GET', apiPath];
  if (paginate) args.push('--paginate');
  // gh applies --jq per page; @json emits one compact JSON array per line.
  // --slurp cannot be combined with --jq.
  args.push('--jq', paginate ? `${projection} | @json` : projection);

  let result;
  try {
    result = execFileSync('gh', args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (error) {
    // Never print gh stderr, process errors, command environments, or response bodies.
    const statusMatch = String(error.stderr ?? '').match(/\bHTTP[ /](\d{3})\b/);
    const httpStatus = statusMatch ? Number(statusMatch[1]) : null;
    if (error.code === 'ENOENT') {
      throw new CollectionError('gh is not installed or is not on PATH.');
    }
    const status = httpStatus === null ? '' : ` (HTTP ${httpStatus})`;
    throw new CollectionError(
      `GitHub collection failed for ${resource}${status}. Check gh authentication, access, and connectivity.`,
      httpStatus,
    );
  }

  try {
    if (paginate) {
      return result
        .trim()
        .split(/\r?\n/)
        .flatMap((line) => JSON.parse(line));
    }
    return JSON.parse(result);
  } catch {
    throw new CollectionError(`GitHub returned an unreadable response for ${resource}.`);
  }
}

function assetKind(name) {
  if (/\.sig$/i.test(name)) return 'signature';
  if (/^latest.*\.(json|ya?ml)$/i.test(name)) return 'updater_manifest';
  if (/\.dmg$|-setup\.exe$|\.msi$/i.test(name)) return 'installer';
  if (/\.(app\.tar\.gz|nsis\.zip|msi\.zip|appimage\.tar\.gz)$/i.test(name)) {
    return 'updater_bundle';
  }
  return 'other';
}

function issueCounts(issues) {
  return {
    total: issues.length,
    open: issues.filter((issue) => issue.state === 'open').length,
    closed: issues.filter((issue) => issue.state === 'closed').length,
  };
}

function collectIssues() {
  const issues = api(
    'issues?state=all&per_page=100',
    '[.[] | select(has("pull_request") | not) | {state, labels: [.labels[].name | ascii_downcase]}]',
    true,
  );
  return {
    classification: 'Exact bug and feedback labels, case-insensitive; pull requests excluded.',
    all: issueCounts(issues),
    bug_reports: issueCounts(issues.filter((issue) => issue.labels.includes('bug'))),
    feedback: issueCounts(issues.filter((issue) => issue.labels.includes('feedback'))),
    both_labels: issueCounts(
      issues.filter((issue) => issue.labels.includes('bug') && issue.labels.includes('feedback')),
    ),
    unclassified: issueCounts(
      issues.filter((issue) => !issue.labels.includes('bug') && !issue.labels.includes('feedback')),
    ),
  };
}

function collectReleases() {
  const releases = api(
    'releases?per_page=100',
    '[.[] | select(.draft | not) | {id, tag: .tag_name, published_at, prerelease, url: .html_url}]',
    true,
  );
  let latestId = null;
  try {
    latestId = api('releases/latest', '.id');
  } catch (error) {
    if (!(error instanceof CollectionError) || error.httpStatus !== 404) throw error;
  }

  const totals = {
    installer: 0,
    updater_bundle: 0,
    signature: 0,
    updater_manifest: 0,
    other: 0,
  };
  for (const release of releases) {
    // The assets embedded in a release response are not a pagination contract.
    const assets = api(
      `releases/${release.id}/assets?per_page=100`,
      '[.[] | {name, size_bytes: .size, download_count}]',
      true,
    );
    release.is_latest_stable = release.id === latestId;
    release.assets = assets.map((asset) => ({ ...asset, kind: assetKind(asset.name) }));
    for (const asset of release.assets) totals[asset.kind] += asset.download_count;
  }

  const currentRelease = releases.find((release) => release.id === latestId) ?? null;
  if (latestId !== null && currentRelease === null) {
    throw new CollectionError('Latest release changed during collection. Capture a new snapshot.');
  }
  return {
    published_release_count: releases.length,
    current_stable_release: currentRelease,
    all_published_releases: releases,
    download_requests_by_asset_kind: totals,
  };
}

function collectTraffic(endpoint) {
  try {
    const data = api(
      `traffic/${endpoint}?per=day`,
      `{count, uniques, days: [.${endpoint}[] | {timestamp, count, uniques}]}`,
    );
    return { status: 'available', ...data };
  } catch (error) {
    if (!(error instanceof CollectionError)) throw error;
    let reason = 'Collection failed; no traffic count is assumed.';
    if (error.httpStatus === 403 || error.httpStatus === 404) {
      reason = 'Access denied or endpoint unavailable; no traffic count is assumed.';
    }
    return { status: 'unavailable', http_status: error.httpStatus, reason };
  }
}

function main() {
  const options = parseOptions(process.argv.slice(2));
  if (options.help) {
    console.log(usage);
    return;
  }
  if (Number(process.versions.node.split('.')[0]) < 24) {
    throw new CollectionError('Run this script with Node.js 24 or newer.');
  }

  const startedAt = new Date().toISOString();
  const metadata = api('', '{url: .html_url, stars: .stargazers_count, forks: .forks_count}');
  const releases = collectReleases();
  const issues = collectIssues();
  const traffic = options.traffic
    ? {
        visibility: 'Access-restricted GitHub aggregates; keep this snapshot private.',
        window: 'GitHub rolling last 14 days; see daily timestamps, not a lifetime total.',
        views: collectTraffic('views'),
        clones: collectTraffic('clones'),
      }
    : { status: 'not_requested' };
  const snapshot = {
    schema_version: 1,
    repository,
    collection_started_at: startedAt,
    captured_at: new Date().toISOString(),
    public: { ...metadata, releases, issues },
    traffic,
    adoption: { users: null, installs: null, retention: null, reason: 'Not measured.' },
    interpretation: [
      'Release download counts are requests, not unique people or successful installs.',
      'Installer requests may include updater downloads, repeat requests, automation, and maintainers.',
      'Stable installer aliases and versioned assets are alternate URLs for the same binary; totals do not deduplicate.',
      'Stars, forks, and labeled issues are GitHub signals, not adoption or retention measurements.',
      'Counters are read sequentially, not atomically; deleted assets/issues and label edits affect comparisons.',
      'A null current stable release means GitHub returned no latest stable release (HTTP 404).',
    ],
  };
  const json = `${JSON.stringify(snapshot, null, 2)}\n`;
  if (options.output !== null) {
    try {
      // Exclusive creation protects baselines; private permissions also cover optional traffic data.
      writeFileSync(options.output, json, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    } catch {
      throw new CollectionError('Could not save snapshot. Choose a writable, new file path.');
    }
  }
  process.stdout.write(json);
}

try {
  main();
} catch (error) {
  const message = error instanceof CollectionError ? error.message : 'Snapshot collection failed.';
  console.error(`launch-metrics: ${message}`);
  process.exitCode = 1;
}
