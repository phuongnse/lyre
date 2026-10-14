---
name: lyre-nexkit
description: Runbook for the local agent session that drives NexKit for the Lyre owner (posting commands, reading plans, triaging pull requests, splitting issues). Use when the owner asks to plan, implement, check, fix or split work through NexKit, or asks about the state of a NexKit issue or pull request. Not for agents running inside the NexKit pipeline.
---

# Driving NexKit for Lyre

The rules, the roles and the life of an issue are in
[docs/delivery.md](../../../docs/delivery.md). Read it first. This file holds
only the practical parts: where values live, the `gh` commands, the review
checklists, upgrading NexKit and what to do when something fails.

You post every command yourself. Post `/nexkit go` only on the latest plan,
after the check below that it holds every agreed change, and only when you
recommend it. Ask the owner first when the plan rests on a **Proposed**
decision or has a question only the owner can answer. Never approve or merge a
pull request yourself. While `merge.auto` is on, NexKit merges and closes the
issue, and with `close_parent_issues` it closes finished parents too. While
`merge.auto` is off, merging is the owner's.

## Where the values live

Look these up each time. Do not copy them into notes or docs, because they
change with a NexKit release or a settings change.

- **NexKit repository and version:** the `nexkit_repository` and `nexkit_ref`
  inputs in the workflow file.

  ```bash
  grep -E 'nexkit_(repository|ref):' .github/workflows/nexkit.yml
  ```

- **NexKit's own docs** (how it works, configuration, troubleshooting): list
  them at that ref, then read the one you need.

  ```bash
  gh api "repos/<nexkit_repository>/contents/docs?ref=<nexkit_ref>" --jq '.[].path'
  gh api "repos/<nexkit_repository>/contents/<path>?ref=<nexkit_ref>" \
    -H 'Accept: application/vnd.github.raw'
  ```

- **Protected paths, the automatic fix limit and automatic merge:**
  `.nexkit/config.json`. When a key is `null` or missing, the value is NexKit's
  default, from its configuration doc at the pinned ref.

  ```bash
  python3 -c "import json; c = json.load(open('.nexkit/config.json')); print(json.dumps({k: c.get(k) for k in ['protected_paths', 'fix', 'merge', 'conflicts', 'usage_limit', 'close_parent_issues', 'notify']}, indent=2))"
  ```

- **Profiles, their `when` texts and models:** `.nexkit/config.json`. A
  profile's stage settings override `stages`, which override the top-level
  `model` and `effort`. The rules behind the profiles are in
  [delivery.md](../../../docs/delivery.md#profiles).

  ```bash
  python3 -c "import json; c = json.load(open('.nexkit/config.json')); print(json.dumps({'default_profile': c.get('default_profile'), 'triage': c.get('stages', {}).get('triage'), 'profiles': c.get('profiles')}, indent=2))"
  ```

- **Caches:** the `cache` entries in `.nexkit/config.json`, which NexKit
  restores before setup, and the `actions/cache` steps in
  `.github/workflows/ci.yml`, which save them on `main`. Each entry and its
  step list the same paths and key files in the same order. The rule is in
  [delivery.md](../../../docs/delivery.md#decisions).

  ```bash
  python3 -c "import json; print(json.dumps(json.load(open('.nexkit/config.json')).get('cache', []), indent=2))"
  ```

- **Required checks on `main`:** the active rules for the branch.

  ```bash
  gh api repos/{owner}/{repo}/rules/branches/main \
    --jq '.[] | select(.type=="required_status_checks") | .parameters.required_status_checks[].context'
  ```

- **NexKit's branch prefix:** the `startsWith(github.event.pull_request.head.ref, '…')`
  condition in the job `if:` block of `.github/workflows/nexkit.yml`.
- **The pull request for an issue:** the link in NexKit's run comment on the
  issue.

## Commands

Post a command:

```bash
gh issue comment <N> --body "/nexkit plan"
gh pr comment <N> --body "/nexkit fix <instructions>"
```

Change the profile of an issue. A request written in the issue text does not
count; it must be a comment:

```bash
gh issue comment <N> --body "/nexkit plan Use the hard profile"
```

Read the latest plan. It is the newest NexKit comment on the issue. It shows
the profile, its models and why triage chose it:

```bash
gh issue view <N> --comments
```

See all open NexKit work and what needs a person with NexKit's local
`status` command, at the pinned ref. It lists each issue and pull request with
its state and last round, the recent merges with their CI runs on `main`, and
a last section with only what needs a person. `--json` gives the same as JSON.
Start every session with it, and use it to watch the work:

```bash
REPO=$(grep -oE 'nexkit_repository: \S+' .github/workflows/nexkit.yml | cut -d' ' -f2)
REF=$(grep -oE 'nexkit_ref: \S+' .github/workflows/nexkit.yml | cut -d' ' -f2)
KIT="${TMPDIR:-/tmp}/nexkit-$REF"
[ -d "$KIT" ] || git clone -q --depth 1 --branch "$REF" "https://github.com/$REPO" "$KIT"
python3 "$KIT/bin/nexkit" status
```

Split an issue that reports `too_large`. Create each part with
`gh issue create --title "<part's behaviour>" --label "<labels>" --milestone "<parent's milestone>"`,
then add the parts to the parent in order. Give each part its own labels,
comma-separated, chosen as in the checklist below. They need not be the
parent's. Title each part by the behaviour it delivers, as for any issue. Never reuse the parent's title, whole or as a
prefix: write `Connector call steps pass compile checks`, not
`Call connector step: compile checks and model`. The sub-issue link already
shows the parent.

```bash
CHILD_ID=$(gh api repos/{owner}/{repo}/issues/<child> --jq .id)
gh api -X POST repos/{owner}/{repo}/issues/<parent>/sub_issues -F sub_issue_id="$CHILD_ID"
```

`sub_issue_id` is the issue's database `id`, not its number. If the endpoint
returns 404, upgrade `gh` and try again.

## Checklist: writing an issue

- One behaviour, aiming for 2–5 acceptance criteria, each checkable by a test
  or command. More than five: check whether the issue holds more than one
  behaviour, and split it if so. If every criterion checks the same behaviour,
  more are fine.
- The text names the concepts the issue touches, in the terms of
  [concepts.md](../../../docs/domain/concepts.md), even when it links to the
  docs. Triage reads only the issue and its discussion, not the links.
- Set every existing repository label that fits the issue's content, at least
  one, when the issue is created. Judge fit by each label's description, which
  `gh label list` prints. The labels are listed at
  <https://github.com/phuongnse/lyre/labels>. No new labels are created. See
  [the life of an issue](../../../docs/delivery.md#the-life-of-an-issue).

## Checklist: reviewing a plan

- The issue is one behaviour, aiming for 2–5 acceptance criteria, each
  checkable by a test or command. More than five: split only if the issue holds
  more than one behaviour. Do not re-plan only to cut the number of criteria.
- The profile in the plan comment fits the issue, judged against the `when`
  texts. If not, re-plan with `/nexkit plan Use the <profile> profile`. If a
  `when` text caused the wrong choice, tell the owner and propose a fix to
  that text as a hand-made pull request.
- Every doc link in the issue and the plan resolves.
- No **Proposed** decision in [decisions.md](../../../docs/decisions.md) is
  treated as **Agreed**.
- The decisions and risks the owner must judge are in their own short sections.
- A `too_large` result leads to sub-issues of the parent, in order and in the
  parent's milestone. Each part's title names its own behaviour and does not
  reuse the parent's title, whole or as a prefix.
- Every change agreed after the plan was posted, from the review or from the
  owner while approving, however small, is commented in the same issue and
  `/nexkit plan` is run again. No follow-up issues.
- A re-plan revises the latest plan, so the comments since that plan state
  only the changes. Choices accepted as they are need no comment.
- Changes in a comment are terse: one short line each, with the exact values,
  names and rules, and no reasons or prose. Nothing the issue or the docs
  already say. See
  [the life of an issue](../../../docs/delivery.md#the-life-of-an-issue).
- After a re-plan, its *Since the last plan* section lists every change that
  was asked for, and nothing else changed without a reason.
- Use `/nexkit plan from scratch` only when the plan has gone wrong, and
  comment every choice to keep before posting it.
- Before asking the owner for go, or posting `/nexkit go`, the latest plan
  holds every agreed change. If not, re-plan first. The plan is the contract:
  it holds the acceptance criteria the pull request is checked against, and it
  is the record a later reader looks at. Re-planning also lets the plan agent
  find other places the change affects, such as another doc that must say the
  same.

## Checklist: breaking down a milestone

- Compare the `when` texts with the concepts that the **From** column of
  [concepts.md](../../../docs/domain/concepts.md) lists for the new
  milestone. Each risky concept must fall under `hard` by its consequence.
- Check whether newer models make a profile's models out of date.
- Check that the caches cover what the milestone's parts download in setup,
  such as a new lock file or toolchain.
- Propose any change to the owner as a hand-made pull request.

## Checklist: reviewing a pull request

- The behaviour change matches the issue and the approved plan.
- When agreed behaviour changes, the docs are updated in the same pull request.
- Tests cover the change, including denied access where it applies, and lyrics kept byte for byte.
- The required checks on `main` are green.
- No edits in paths NexKit may not change, unless the pull request is hand-made.
- When the change adds a lock file, a toolchain or another download to setup,
  or moves a cache's key file, propose a hand-made pull request that updates
  the cache entry and its CI step together.
- While `merge.auto` is on, NexKit has merged by the time you look: review the
  merged pull request the same way, and raise problems with the owner. While it
  is off, NexKit mentions the owner when a pull request is ready.

## Upgrading NexKit

Do this when the owner says a new NexKit release is out, or asks to upgrade.
An upgrade is a hand-made pull request, because it changes `.github/` and
`.nexkit/`.

1. Read the `CHANGELOG.md` entries between the pinned `nexkit_ref` and the new
   tag. Note each **Upgrade:** step, each renamed key and each new setting.
2. Compare `nexkit/templates/workflow.yml` at both tags. Apply the template's
   changes to `.github/workflows/nexkit.yml`, then move both refs in it.
3. For each new setting, decide whether Lyre should use it, and say why in the
   pull request. Settings that need a matching change elsewhere, such as
   caches and their CI steps, change together.
4. Run `nexkit doctor` at the new tag, from a clone as for `status`. Every line
   must pass.
5. Update [delivery.md](../../../docs/delivery.md) and this file when the
   release changes how work flows, and run `node scripts/check-links.mjs`.
6. Open the pull request from a branch whose name does not start with
   NexKit's branch prefix, so CI runs on it. The owner merges it with the
   admin bypass after CI passes.

## When something fails

| Failure | What the local agent does |
| --- | --- |
| Publish fails after `/nexkit go` | Read the run log. If the base branch was force-pushed, the same `/nexkit go` fixes it. Otherwise diagnose first. Ask the owner before posting `/nexkit go` again. |
| A round ends as `blocked` | Answer the question with `/nexkit fix <decision>`. Ask the owner first when the choice is theirs. |
| Merge conflict with `main` | Nothing: NexKit starts a conflict round by itself. Answer a `blocked` question with `/nexkit fix <decision>`. After `conflicts.max_rounds` such rounds, comment `/nexkit fix` yourself. |
| Conflict in a path NexKit may not change, or a merge that brings workflow changes | Merge `origin/main` into the pull request branch by hand, in a separate worktree. Run the build, lint and test scripts listed in AGENTS.md. Ask the owner before pushing, then comment `/nexkit review`. |
| The plan comment says triage failed | The plan ran on the previous plan's profile or on `default_profile`. If that profile is wrong for the issue, re-plan with `/nexkit plan Use the <profile> profile`. |
| A round stops because its plan names a profile that is no longer configured | Re-plan with `/nexkit plan`, then repeat the command that stopped. Ask the owner first when that command is `/nexkit go`. |
| A run is paused at the Claude usage limit (⏸️) | Nothing: NexKit runs the same command again after the reset. If it stops a second time with an unknown reset time, repeat the command. |
| The review job errored | Comment `/nexkit review` to retry. |
| The review requested changes | NexKit runs automatic fix rounds up to the configured limit. After that, ask the owner and post `/nexkit fix <instructions>`. |
| NexKit's automatic merge was refused (`merge_refused`) | A conflict starts a conflict round by itself. Otherwise the round's comment says why, usually a rule on `main`. NexKit has mentioned the owner; tell them what you found. |
| The *Restore caches* step misses an entry after CI on `main` saved it | Compare the entry in `.nexkit/config.json` with its CI step: name, paths and key files, in the same order. Check that the save ran on `main`, on `ubuntu-24.04`, and that its step comes before setup. Fix both files in a hand-made pull request. A miss never fails a round. |
| CI on `main` fails after a merge | If the failure looks flaky, run it once more with `gh run rerun <id> --failed`. Otherwise tell the owner and open a bug issue with the failure and the run link, in the current milestone, and plan it before other issues. |

For the mechanics behind each failure, read NexKit's troubleshooting doc at the
pinned ref, found as described under "Where the values live".
