# Delivery workflow

Lyre is built through NexKit. NexKit runs one issue per agent session. People
drive it with four comment commands: `/nexkit plan` and `/nexkit go` on an
issue, and `/nexkit fix` and `/nexkit review` on its pull request.

Three roles take part:

- **The owner** decides what only the owner can: **Proposed** design points,
  questions a plan or a blocked round asks of the owner, and whether NexKit
  merges its own pull requests. NexKit mentions the owner when a run needs a
  person.
- **The local agent session** drives NexKit for the owner. It writes issues,
  posts commands, reviews plans and says go, and watches the work.
- **NexKit's agents** plan, implement, fix and review inside the NexKit
  pipeline. They read [AGENTS.md](../AGENTS.md).

The rules here put [D11](decisions.md#d11-delivery-workflow--agreed) into
practice. Values that NexKit or the repository settings own, such as protected
paths, required checks, the automatic fix limit and the profiles with their
models, are not copied here. Look them up where they live.

## Decisions

- **The local agent posts every command itself, `/nexkit go` included.** It
  posts `/nexkit go` on the latest plan once it holds every agreed change and
  the local agent recommends it. It asks the owner first when the plan rests
  on a **Proposed** decision or has a question only the owner can answer.
- **NexKit merges a pull request once it passes, while `merge.auto` is on.**
  With NexKit's [`merge.auto` setting][nexkit-auto-merge] on, NexKit
  squash-merges a pull request as soon as every check passes and the AI review
  approves. Then it closes the issue the pull request implements. The owner
  turns the setting off to decide each merge again, and then only the owner
  merges. The switch is in `.nexkit/`, so changing it is a hand-made pull
  request.
- **NexKit mentions the owner when a person is needed.** The owner's login is
  in NexKit's [`notify` setting][nexkit-config]. NexKit mentions it when a run
  ends in a state that needs a person: a plan with questions or too large for
  one session, a blocked or failed run, no automatic fix rounds left, or a
  refused automatic merge. Every other run needs nobody.
- **NexKit resolves conflicts with `main` by itself.** With
  `conflicts.auto_resolve` on, each time `main` moves NexKit starts a fix round
  for every open NexKit pull request that now conflicts with it. A conflict
  that needs a choice ends the round as `blocked`, with a question.
- **NexKit pauses at the Claude usage limit and resumes after it resets.** The
  run's comment shows the reset time. No person repeats the command.
- **A parent issue closes when its last part does.** With
  `close_parent_issues` on, NexKit closes a parent issue once every sub-issue
  is closed and at least one was completed.
- **The rules on `main` let NexKit merge.** They require NexKit's own checks
  and no approval from a person. They do not require the CI workflow, which
  runs on pushes to `main` and to hand-made branches but not on NexKit's
  branches. NexKit's checks run the same scripts there.
- **CI runs on `main` after every merge.** A merge by NexKit starts no `push`
  workflow, so NexKit starts the CI workflow on `main` itself, through its
  `merge.after_workflows` setting. Two pull requests that pass on their own
  can still break `main` together. When CI on `main` fails, the local agent
  runs it once more if the failure looks flaky. Otherwise it tells the owner
  and opens a bug issue with the failure, which goes before other issues.
- **CI on `main` deploys the web client to GitHub Pages.** When every check
  passes on `main`, CI publishes the web client it built and tested to
  <https://phuongnse.github.io/lyre/>. The check pages run there on real
  devices, over HTTPS. It is a development build until the M9 release. The
  build must work from that `/lyre/` path.
- **NexKit restores caches, and only CI on `main` saves them.** NexKit's
  agent and checks jobs restore the caches in its `cache` setting before
  setup, so a round does not download every dependency again. They never save
  one, because they run code the agent wrote. The CI workflow saves each cache
  when it runs on `main`. Each entry in `.nexkit/config.json` and its step in
  the CI workflow list the same paths and key files in the same order, or
  NexKit does not find the cache. Both files are out of NexKit's reach, so a
  part that adds a dependency cache gets its entries in a hand-made pull
  request.
- **Everything goes through NexKit, except changes in paths NexKit may not
  change.** Those paths are set by NexKit's
  [`protected_paths` setting][nexkit-config].
  Such changes are hand-made pull requests on any branch name, for example a
  NexKit version bump. The owner opens them from their own account. NexKit's
  checks do not run on them, so the owner merges them with an admin bypass of
  the rules on `main`, after the CI workflow passes.

## Profiles

Each issue runs on one NexKit profile. The profile sets the models for the
plan, implement, fix and review rounds of that issue. When `/nexkit plan`
starts, NexKit's triage step reads the issue and chooses the profile. The
profiles, their `when` texts and their models are in NexKit's
[`profiles` setting][nexkit-profiles]. This section holds the rules behind
them.

- **Profiles go by risk: `standard` and `hard`.** The more a mistake would
  cost, the stronger the profile. `standard` is the default.
- **Plan and review are at least as strong as implement.** The plan is the
  contract and the review is the last check before the owner. In every
  profile, review runs on a different model from implement.
- **Triage runs on a strong model.** It is one call that reads only the
  issue, so it costs little, and a wrong choice does not fail: the issue just
  runs on the wrong profile.
- **A `when` text says what a mistake would cost, not where the code is.** It
  may name concepts from [concepts.md](domain/concepts.md) as examples, but
  never files, classes, doc sections or milestones, which go stale. `hard` is
  broad and `standard` is the rest. When unsure, triage chooses the stronger
  profile.
- **Triage sees only the issue and its discussion.** It does not open links.
  So an issue names the concepts it touches in its own text, even when it
  links to the docs that describe them.
- **A comment changes the profile.** Comment
  `/nexkit plan Use the <profile> profile`. A request written in the issue
  text does not count. A re-plan keeps the profile unless someone asks for
  another one.
- **Profile changes are hand-made pull requests,** because `.nexkit/` is a
  path NexKit may not change.

## The life of an issue

1. **Write the issue.** One issue is one behaviour, aiming for 2–5 acceptance
   criteria that a test or command can check. More than five is a signal to
   check whether the issue holds more than one behaviour. If it does, split it.
   If every criterion checks the same behaviour, more are fine. A plan is not
   revised only to cut the number of criteria. It links to the doc sections it
   implements and is in the current milestone. Its text names the concepts it
   touches, so triage can choose the [profile](#profiles).
   When it is created, it gets every existing
   [repository label](https://github.com/phuongnse/lyre/labels) that fits its
   content, at least one. Whether a label fits is judged by its description on
   GitHub. No new labels are created for this.
2. **Plan.** Comment `/nexkit plan` on the issue. NexKit's plan agent posts a
   plan as a comment.
3. **Review the plan.** Check it against [decisions.md](decisions.md), and
   never treat a **Proposed** decision as **Agreed**. Check the profile and
   the reason shown in the plan comment. If the profile is wrong, comment
   `/nexkit plan Use the <profile> profile`. If a `when` text caused the
   wrong choice, fix that text in a hand-made pull request. Any change agreed after
   the plan is posted, whether the review finds a gap or the owner decides
   something while approving, however small, is commented in the same issue
   and `/nexkit plan` is run again before `/nexkit go`. A re-plan revises the
   latest plan. It keeps what no newer comment asks to change, and its *Since
   the last plan* section lists what changed. So a review comment states only
   the changes. Write each one tersely, on one short line, with the exact
   values, names and rules, and drop reasons and prose. The reasons are in the
   plan and the docs. Do not repeat what the issue or the merged docs already
   say. Link to the doc instead. For example:
   `Change: limits 2,000 chars / depth 32 / 500 nodes; == null-safe; trim not in SQL.`
   Check the *Since the last plan* section against those comments. A note such
   as `/nexkit plan from scratch` plans again without the latest plan's
   choices. Use it only when the plan has gone wrong, and then comment every
   choice to keep first. `/nexkit go`
   only runs on the latest plan, and that plan holds every agreed change. The reason:
   the plan is the contract. It holds the acceptance criteria the pull request
   is checked against, and it is the record a later reader looks at. A change
   that lives only in a comment is missing from both. Re-planning also lets
   the plan agent find other places the change affects, such as another doc
   that must say the same. Do not open follow-up issues. When the plan reports
   `too_large`, split the issue into parts. Each part is written like any
   issue, and its title names the behaviour that part delivers. It does not
   reuse the parent's title, whole or as a `<parent>: <part>` prefix, because
   the sub-issue link already shows the parent. Add each part as a GitHub
   sub-issue of the parent, in order and in the parent's milestone. Each part
   gets its own labels, which need not be the parent's. NexKit closes the
   parent when all parts are done.
4. **Implement.** The local agent posts `/nexkit go` on the latest plan, as
   described under Decisions. NexKit implements that plan and opens a pull
   request.
5. **Pull request.** Every round runs NexKit's checks and the AI review on the
   new commit. Merging needs both to pass.
6. **Fix.** Comment `/nexkit fix <instructions>` for another round. NexKit
   starts the rounds for merge conflicts by itself: it merges `main` into the
   branch, it does not rebase. When a conflict needs a choice, the round stops
   as `blocked` with a question. Answer it with `/nexkit fix <decision>`.
   After a manual push, comment `/nexkit review`. If the review job itself
   fails with an error, `/nexkit review` retries it. If the review requests
   changes, NexKit starts automatic fix rounds up to the limit in its
   configuration. After that, a person decides on `/nexkit fix`.
7. **Merge.** NexKit squash-merges, starts CI on `main` and closes the issue.
   With `merge.auto` off, the owner squash-merges instead, and GitHub closes
   the issue.
8. **Exceptions.** Changes whose purpose is to edit paths NexKit may not change
   are hand-made pull requests, as described under Decisions. A conflict in
   those paths, or a merge that brings workflow changes, is different: merge
   `origin/main` into the NexKit pull request branch by hand, in a separate
   worktree. Run build, lint and tests, ask the owner before pushing, then
   comment `/nexkit review`.

## The life of a milestone

1. **Break it down.** When the current milestone is nearly done, break the
   next one into issues, as the [roadmap](roadmap.md#how-work-is-planned)
   describes. Then check the [profiles](#profiles) against the concepts that
   the **From** column of [concepts.md](domain/concepts.md) lists for the new
   milestone, and against the models now available. Fix them in a hand-made
   pull request.
2. **Deliver the issues.** Each one follows the life of an issue above.
3. **Docs sweep.** Before the owner closes the milestone, one issue in it
   checks the docs and fixes what the milestone made stale. It checks at
   least:
   - the roadmap status of this milestone and the next one;
   - the **From** column of [concepts.md](domain/concepts.md) for every
     concept listed for this milestone, moved to a later milestone when the
     concept was not delivered;
   - every *(planned for Mx)* marker for this milestone in any doc, removed
     when the work was built and moved to a later milestone when it was not.
4. **Close.** The owner closes the milestone on GitHub once the docs sweep
   is merged.

## Keeping the docs current

- **The roadmap is the only place for milestone status.**
  [roadmap.md](roadmap.md) records each milestone's status and what it
  delivers. Other docs link to it instead of repeating it.
- **One marker for planned work.** Any doc text that describes something not
  built yet carries *(planned for Mx)*, where Mx is the milestone that builds
  it. This applies to every doc, not only the architecture. The docs sweep
  removes or moves these markers when a milestone closes.
- **No false statements left behind.** A change that makes any doc statement
  false fixes it in the same change. The rule is in the
  [AGENTS.md working rules](../AGENTS.md#working-rules), so the NexKit review
  applies it to every pull request.
- **Rules and reasons, not incident history.** Docs state each rule and why
  it exists. They do not retell incidents or cite issue or pull request
  numbers as examples. That history belongs in issues, pull requests and git.
  Links to decisions and doc sections stay, and so do links that track work,
  such as the roadmap's link to a GitHub milestone.

## Writing on GitHub

These rules apply to issues, plans, pull request descriptions and reviews.

- Lead with the point. Use short sentences and one idea per bullet.
- Say what changes in behaviour, and why, before naming classes or files.
- Put decisions and risks the owner must judge in their own short section.
- Keep implementation detail (signatures, SQL, file-by-file steps) out of the
  main text, or put it in a collapsed `<details>` block.

[nexkit-config]: https://github.com/phuongnse/nexkit/blob/main/docs/configuration.md
[nexkit-profiles]: https://github.com/phuongnse/nexkit/blob/main/docs/configuration.md#profiles
[nexkit-auto-merge]: https://github.com/phuongnse/nexkit/blob/main/docs/configuration.md#automatic-merge
