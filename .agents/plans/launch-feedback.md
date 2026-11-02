# Feedback-first launch kit

## Send gate — not ready for outreach

Do not post until all three are true:

1. **Completed for [v0.7.4](https://github.com/energee/appletv-desktop-remote/releases/tag/v0.7.4), published 2026-11-02.** The [release workflow](https://github.com/energee/appletv-desktop-remote/actions/runs/41488227375) passed for Apple silicon, Intel Mac, and Windows x64. All three stable installer URLs returned HTTP 200 and their SHA-256 digests matched the versioned originals; all three updater signatures and trusted comments verified against the committed public key. Use this release's actual capabilities and caveats, not unreleased promises.
2. Authentic footage demonstrates the desktop app controlling a **real Apple TV**. **Actual footage is not yet available.** No connected recording hardware or existing project video has been identified. Website interaction is a simulation, not hardware proof; do not substitute it or invent a media link.
3. Read the current [r/appletv rules](https://www.reddit.com/r/appletv/about/rules/) and obtain any required moderator permission for a maintainer/project post. Rules or permission have **not** been verified by this kit. Send the modmail below first when permission is unclear; no response is not permission.

No social posting has been performed. Start with **one community only: r/appletv**, if permitted. Do not cross-post during the initial feedback window.

## Genuine demonstration shot list

Record after pairing, using a neutral TV screen and non-private test text. Disable notifications; keep PINs, pairing keys, credential backups, account names, watch history, and private content out of frame. Do not record the pairing PIN itself.

- Begin with a continuous wide shot showing the computer keyboard, desktop remote, and physical TV together. Identify the released app version/platform in the accompanying description.
- Press arrow keys and Enter; show the matching **visible TV navigation/selection**, not just remote button animation. Show enough of the hands/keyboard to connect the action with the TV response.
- Start safe, non-private playback, then use Space to pause and resume; capture the actual TV response. Avoid copyrighted clips where possible and do not imply every app supports the same playback controls.
- With Companion paired, focus a TV search/text field. Show the desktop text input appearing, enter neutral text, and capture that text appearing on the TV. Leave the TV field and show the input closing. Do not imply arbitrary background typing or universal app support.
- Trim only for privacy/length; disclose cuts or separate takes rather than implying continuous proof. Label any separate website demo explicitly **“website simulation — not connected to a TV.”** Prefer the real clip for outreach; website animation alone does not meet the gate.

## Capture a baseline and follow-ups

Prerequisites: Node.js 24, `gh` already authenticated to github.com with appropriate repository access. Run from the repository root. The script always targets `energee/appletv-desktop-remote`, regardless of the local `gh` repository context. It makes read-only API calls, follows pagination for releases, each release's assets, and all-state issues, and excludes pull requests and draft releases.

The first post-release baseline was captured at **2026-11-02T17:37:04Z** for v0.7.4 and saved locally to `.agents/launch-metrics/baseline.json` with owner-only permissions. It is deliberately excluded from Git. Refresh the snapshot immediately **before outreach**, using a new filename:

```sh
mkdir -p .agents/launch-metrics
pnpm metrics:launch --output ".agents/launch-metrics/pre-post-$(date -u +%Y%m%dT%H%M%SZ).json"
```

Capture a later snapshot with a distinct filename, for example seven days after outreach:

```sh
pnpm metrics:launch --output .agents/launch-metrics/day-7.json
```

Optional access-restricted traffic snapshot (owner/push access may be required):

```sh
pnpm metrics:launch --traffic --output .agents/launch-metrics/private-day-7.json
```

The direct Node equivalent is `node scripts/launch-metrics.mjs` with the same flags; `--help` prints usage. The JSON is also printed to stdout; the output file contains the same snapshot. New files use owner-only permissions where supported, and existing files are never overwritten. Parent directories must already exist. Do not run private traffic captures in public CI/logs, paste their stdout publicly, or commit their files. Use the ignored `.agents/launch-metrics/` directory or a private directory outside the checkout; never force-add snapshots. Restrict access and share only a deliberately reviewed public-only summary. The snapshot contains aggregate counters, release tags/asset names, and timestamps, not tokens, user/commenter identities, issue bodies, or app credentials. The script does not print raw `gh` errors. Public collection failure exits nonzero without saving a new snapshot; optional traffic failure is recorded as unavailable, not a zero count. If output writing fails, discard any incomplete file before choosing a new path.

Record the release tag, outreach time/permalink (only after posting), permission decision, and known maintainer/test download activity alongside private notes. The initial baseline includes release verification activity; download counters can lag and never establish unique users or installations.

### Interpret the denominators honestly

| Signal                       | What to compare                                                                                                                                                                           | What it cannot establish                                                                                                                                                                                                                   |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Stars / forks                | GitHub's repository counters and their change since baseline                                                                                                                              | Active users, installs, product satisfaction, or retention; removals can lower counters                                                                                                                                                    |
| Per-asset `download_count`   | Request-count changes for the **same release ID and asset name**, with installer/updater categories kept separate                                                                         | Unique people, successful installations, launches, or use; automation, repeat requests, maintainers, and updater clients may contribute                                                                                                    |
| Installer request sum        | `.dmg`, `-setup.exe`, and `.msi` assets only                                                                                                                                              | New users; stable installer aliases and versioned filenames can be alternate URLs for identical binaries. Counts are summed by URL/asset, not deduplicated by person or binary. Some installers also serve updater clients                 |
| Other release requests       | Known updater bundles (`.app.tar.gz`, `.nsis.zip`, `.msi.zip`, `.AppImage.tar.gz`), `.sig` signatures, and `latest*.json/yml/yaml` manifests separately; unknown filenames remain `other` | Updater checks, update success, or user totals. Naming classification is not proof of how a file was used                                                                                                                                  |
| Issues                       | All/open/closed issues, exact case-insensitive `bug` and `feedback` labels, their overlap, and unclassified issues                                                                        | Every experience or a conversion rate. Forms use those labels; repository labels must exist for automatic assignment. Unlabeled historical reports are not guessed from text. Overlap is explicit, so bug + feedback is not a unique total |
| Optional views / clones      | GitHub rolling last-14-day aggregate counts and GitHub-reported uniques, with daily timestamps                                                                                            | App installs/users or retention. GitHub's endpoint-specific unique visitors/cloners are not identifiable app users; views and clones are separate populations. Never add overlapping windows' unique counts                                |
| Users / installs / retention | Explicitly `null` / **not measured**                                                                                                                                                      | There is no defensible adoption or retention figure from these sources, and no telemetry is being added                                                                                                                                    |

`current_stable_release` follows GitHub's latest-release endpoint; prereleases remain in the published-release list. No latest stable release is represented as `null`, not guessed from tag ordering. All-release totals include old releases and prereleases, so prefer current-release per-asset deltas for this launch. Deleted/replaced assets, issue transfers/deletions, label edits, and reopened issues change counters; do not turn negative changes into zero or interpret net open/closed changes as newly submitted reports. Collection timestamps bound sequential requests, not an atomic read. Traffic HTTP 403/404 is explicitly unavailable; other optional traffic failures are also unavailable. Missing access never means no visitors.

### Cadence and action

- Capture baseline immediately before the first permitted post, then approximately 24 hours, 7 days, and 14 days afterward. If using traffic data, capture at least weekly because GitHub exposes only a rolling window. This is manual, not scheduled automation.
- Spend the initial day answering questions, then check the thread daily for a week. Consolidate duplicates into existing issues, and ask permission before moving identifying details from Reddit to GitHub. Track recurring problems privately without handles or raw conversation exports.
- **Actionable setup/bug feedback:** app version, computer OS/architecture, tvOS version if known, failing step/expected versus actual result, reproducibility, and whether basic pairing or Companion is involved. Never request PINs, keys, credential exports, private viewing details, or unredacted logs. A single reproducible pairing/install/privacy failure deserves triage; two independent reports of the same confusing step justify a setup-copy fix even without a code reproduction.
- **Actionable feature feedback:** the concrete task, current workaround, and why the present controls fail it. Clarify before promising a feature. Capture the outcome and link the issue/fix back to the original discussion when appropriate.
- At day 7, summarize request deltas and labeled feedback with these limitations, plus actual resolved/reproduced blockers. If setup blockers remain, fix them before expanding outreach. If discussion is quiet, do not manufacture adoption claims or repost for attention. Choose a second community only after reviewing feedback and its current rules separately.

## Modmail permission draft

**Subject:** Permission to request feedback on an open-source desktop Apple TV remote?

Hi r/appletv moderators — I work on Apple TV Remote, a free, GPL-licensed macOS/Windows desktop remote for Apple TV. Would a single clearly disclosed project post asking for setup/usability feedback be welcome under your current rules, or is there a preferred thread or format?

The post would include authentic footage of the app controlling a real Apple TV, disclose first-launch security warnings and same-network/Companion pairing requirements, and link to GitHub downloads/source. It would not ask for upvotes or stars. I would answer questions in the thread and avoid repeated promotion. Project: https://github.com/energee/appletv-desktop-remote

Please let me know whether this is permitted and any conditions. I will not post if it is not a fit. Thank you.

## r/appletv draft — only after the send gate

**Title:** Feedback wanted: a free, open-source Apple TV remote for macOS and Windows

Disclosure: I work on this project. Apple TV Remote is a desktop app for controlling an Apple TV on the same network, with keyboard navigation, play/pause, a touchpad, and now-playing controls. With Companion paired, it can also launch installed apps and type while a text field is focused on the TV.

I'd particularly appreciate feedback on two things: **Was first-time setup clear?** And **does desktop keyboard control fit a real use case for you, or get in the way?** If something fails, the app version, computer OS/architecture, and the step that failed are useful; please don't share pairing PINs, credentials, or private content.

A couple of caveats before downloading: macOS currently needs the documented first-launch security exception because the app is not notarized; Windows may show SmartScreen. Your computer and Apple TV need to be on the same network. Apps/text input and optional smooth scrolling require a second Companion pairing; focused text input isn't available on every screen. This is an independent project, not an Apple product.

Download/setup: https://github.com/energee/appletv-desktop-remote#readme

You can leave feedback here; a GitHub account isn't required to discuss it. If you prefer an issue form, the repository has bug-report and feedback options. Source is GPL-3.0-only. Thanks for any concrete setup or usability feedback — I'll be in the thread to answer questions.

**Before submitting:** attach the genuine TV clip, recheck security/platform wording against the published build, and honor the moderators' format/permission conditions. Do not add simulated footage as proof, a mandatory repository/star CTA, an upvote request, or unsupported claims about users, reliability, or Apple endorsement.

## Response approach

Lead with the answer rather than another download link. Thank people for specific observations; acknowledge unsupported setups and distinguish a reproduced bug from an unconfirmed report. Explain the Companion limitation when relevant instead of blaming a user for pairing trouble. Offer an issue link only when it helps preserve reproduction steps, not as a requirement for receiving help. Correct an inaccurate claim in the original post promptly; if the release has an install/privacy/control regression, pause further promotion and explain the mitigation. Respect removals, stop on a moderator request, and do not DM people unsolicited.
