// Contributor License Agreement check for pull requests (CLA.md).
//
// Called from .github/workflows/cla.yml via actions/github-script on
// pull_request_target (a PR opened or updated) and issue_comment (someone
// commented on a PR). It never checks out or runs PR code: it only reads the
// PR's commit list through the API.
//
// Every GitHub user who authored or co-authored (Co-authored-by trailer) a
// commit in the PR, plus the PR author, has to sign once by commenting
// SIGN_PHRASE. Authors that can't be tied to a GitHub account keep the check
// red, so it fails closed. Signatures are stored as JSON on
// the SIGNATURES_BRANCH branch (created on the first signature), keyed by the
// immutable GitHub user id, so a renamed account stays signed.
//
// The result is reported as the "CLA" commit status on the PR head rather
// than as this job's own result: a run triggered by a comment is not attached
// to the PR, so only a commit status can turn the check green after signing.
// Make "CLA" a required status check in the branch protection for master.

const SIGN_PHRASE = "I have read the CLA and I agree to its terms."
const RECHECK = "recheck"
const CLA_VERSION = "1"
const STATUS_CONTEXT = "CLA"
const MARKER = "<!-- cla-check -->"
const SIGNATURES_BRANCH = process.env.CLA_BRANCH || "cla-signatures"
const SIGNATURES_PATH = `signatures/cla-v${CLA_VERSION}.json`
// The comment author of the workflow's GITHUB_TOKEN.
const BOT_LOGIN = "github-actions[bot]"
// The PR commits endpoint returns at most this many commits.
const MAX_COMMITS = 250
// AI coding assistants credited as authors or co-authors. They hold no
// copyright; the human who opened the PR signs for the work.
const AI_AUTHOR_EMAILS = ["noreply@anthropic.com", "codex@openai.com"]
const NOREPLY_EMAIL = /^(?:\d+\+)?([a-z0-9-]+)@users\.noreply\.github\.com$/i
const CO_AUTHOR_TRAILER = /^co-authored-by:\s*(.*?)\s*<([^>]+)>\s*$/gim

const normalize = (text) =>
  String(text || "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase()

// Git author names come from the contributor's machine, so they could carry
// markdown or @mentions. Shown as inline code, with backticks removed.
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const code = (text) => "`" + String(text).replace(/[`\r\n]/g, "") + "`"

module.exports = async ({ github, context, core }) => {
  const { owner, repo } = context.repo
  const allowlist = new Set(
    [owner, ...(process.env.CLA_ALLOWLIST || "").split(",")]
      .map((login) => login.trim().toLowerCase())
      .filter(Boolean)
  )
  const defaultBranch = context.payload.repository?.default_branch || "master"
  const claUrl = `${context.serverUrl || "https://github.com"}/${owner}/${repo}/blob/${defaultBranch}/CLA.md`

  let prNumber
  let signingComment = null
  if (context.eventName === "issue_comment") {
    const { issue, comment } = context.payload
    if (!issue.pull_request) return
    const body = normalize(comment.body)
    if (body === normalize(SIGN_PHRASE)) signingComment = comment
    else if (body !== RECHECK) return
    prNumber = issue.number
  } else {
    const { action, changes } = context.payload
    if (action === "edited" && !changes?.base) return
    prNumber = context.payload.pull_request.number
  }

  const { data: pr } = await github.rest.pulls.get({
    owner,
    repo,
    pull_number: prNumber,
  })
  if (pr.state !== "open") return

  const setStatus = (state, description) =>
    github.rest.repos.createCommitStatus({
      owner,
      repo,
      sha: pr.head.sha,
      state,
      context: STATUS_CONTEXT,
      description,
      target_url: claUrl,
    })

  // The maintainer's own PRs (including commits written with AI tools, which
  // carry no GitHub account) don't need a CLA.
  if (allowlist.has(pr.user.login.toLowerCase())) {
    await setStatus("success", "Maintainer pull request, no CLA needed")
    return
  }

  if (pr.commits > MAX_COMMITS) {
    await setStatus(
      "failure",
      `More than ${MAX_COMMITS} commits, authors can't be checked`
    )
    return
  }

  const exemptEmails = new Set(
    [...AI_AUTHOR_EMAILS, ...(process.env.CLA_EXEMPT_EMAILS || "").split(",")]
      .map((email) => email.trim().toLowerCase())
      .filter(Boolean)
  )
  const { required, unlinked } = await collectAuthors(
    github,
    owner,
    repo,
    pr,
    exemptEmails
  )
  const isAllowed = (user) =>
    user.type === "Bot" || allowlist.has(user.login.toLowerCase())
  const toSign = [...required.values()].filter((user) => !isAllowed(user))

  let store = await loadSignatures(github, owner, repo)
  const isSigned = (user) => store.signatures.some((s) => s.id === user.id)

  if (
    signingComment &&
    !isSigned(signingComment.user) &&
    toSign.some((user) => user.id === signingComment.user.id)
  ) {
    store = await addSignature(github, owner, repo, store, {
      id: signingComment.user.id,
      login: signingComment.user.login,
      claVersion: CLA_VERSION,
      signedAt: signingComment.created_at || new Date().toISOString(),
      pullRequest: pr.number,
      commentUrl: signingComment.html_url,
    })
    core.info(`Recorded CLA signature of ${signingComment.user.login}`)
  }

  const missing = toSign.filter((user) => !isSigned(user))
  const done = missing.length === 0 && unlinked.length === 0

  if (done) {
    await setStatus("success", "All contributors have signed the CLA")
  } else {
    const count = missing.length + unlinked.length
    await setStatus(
      "failure",
      `${count} contributor${count === 1 ? " has" : "s have"} not signed the CLA yet`
    )
  }
  await upsertComment(github, owner, repo, pr.number, {
    done,
    missing,
    unlinked,
    claUrl,
  })
}

async function collectAuthors(github, owner, repo, pr, exemptEmails) {
  const commits = await github.paginate(github.rest.pulls.listCommits, {
    owner,
    repo,
    pull_number: pr.number,
    per_page: 100,
  })
  const required = new Map([[pr.user.id, pr.user]])
  const unlinked = new Map()
  // An email that belongs to no GitHub account: nobody can sign for it.
  const addUnlinked = (name, email) => {
    if (!exemptEmails.has(email.toLowerCase()))
      unlinked.set(email, { name, email })
  }
  const coAuthors = new Map()
  for (const commit of commits) {
    if (commit.author) {
      required.set(commit.author.id, commit.author)
    } else {
      const { name, email } = commit.commit.author
      addUnlinked(name, email)
    }
    for (const [, name, email] of commit.commit.message.matchAll(
      CO_AUTHOR_TRAILER
    )) {
      if (!exemptEmails.has(email.toLowerCase())) coAuthors.set(email, name)
    }
  }
  for (const [email, name] of coAuthors) {
    const user = await findUserByEmail(github, email)
    if (user) required.set(user.id, user)
    else addUnlinked(name, email)
  }
  return { required, unlinked: [...unlinked.values()] }
}

// Trailers carry only a name and an email. A GitHub noreply address names
// the account; any other email must match exactly one account whose public
// email it is, or the co-author counts as unlinked.
async function findUserByEmail(github, email) {
  const noreply = email.match(NOREPLY_EMAIL)
  try {
    if (noreply) {
      const { data } = await github.rest.users.getByUsername({
        username: noreply[1],
      })
      return data
    }
    const { data } = await github.rest.search.users({
      q: `${email} in:email`,
    })
    return data.total_count === 1 ? data.items[0] : null
  } catch (error) {
    if (error.status === 404 || error.status === 422) return null
    throw error
  }
}

async function loadSignatures(github, owner, repo) {
  try {
    const { data } = await github.rest.repos.getContent({
      owner,
      repo,
      path: SIGNATURES_PATH,
      ref: SIGNATURES_BRANCH,
    })
    const json = Buffer.from(data.content, "base64").toString("utf8")
    return { signatures: JSON.parse(json).signatures, sha: data.sha }
  } catch (error) {
    if (error.status === 404) return { signatures: [], sha: null }
    throw error
  }
}

async function addSignature(github, owner, repo, store, signature) {
  // Runs for other PRs can write the file between our read and write; GitHub
  // then rejects the stale sha (409, or 422 when two runs create the branch)
  // and we re-read and try again after a short random wait.
  for (let attempt = 1; ; attempt++) {
    if (store.signatures.some((s) => s.id === signature.id)) return store
    const signatures = [...store.signatures, signature]
    const content = JSON.stringify({ signatures }, null, 2) + "\n"
    const message = `chore(cla): ${signature.login} signed CLA v${CLA_VERSION} in #${signature.pullRequest}`
    try {
      if (!(await branchExists(github, owner, repo))) {
        await createSignaturesBranch(github, owner, repo, content, message)
      } else {
        await github.rest.repos.createOrUpdateFileContents({
          owner,
          repo,
          path: SIGNATURES_PATH,
          branch: SIGNATURES_BRANCH,
          message,
          content: Buffer.from(content).toString("base64"),
          ...(store.sha ? { sha: store.sha } : {}),
        })
      }
      return { signatures, sha: null }
    } catch (error) {
      if (attempt >= 10 || ![409, 422].includes(error.status)) throw error
      await sleep(Math.random() * 1000 * attempt)
      store = await loadSignatures(github, owner, repo)
    }
  }
}

async function branchExists(github, owner, repo) {
  try {
    await github.rest.git.getRef({
      owner,
      repo,
      ref: `heads/${SIGNATURES_BRANCH}`,
    })
    return true
  } catch (error) {
    if (error.status === 404) return false
    throw error
  }
}

// The signatures branch shares no history with the code: an orphan commit
// holding only the signatures file.
async function createSignaturesBranch(github, owner, repo, content, message) {
  const { data: tree } = await github.rest.git.createTree({
    owner,
    repo,
    tree: [{ path: SIGNATURES_PATH, mode: "100644", type: "blob", content }],
  })
  const { data: commit } = await github.rest.git.createCommit({
    owner,
    repo,
    message,
    tree: tree.sha,
    parents: [],
  })
  await github.rest.git.createRef({
    owner,
    repo,
    ref: `refs/heads/${SIGNATURES_BRANCH}`,
    sha: commit.sha,
  })
}

// One bot comment per PR, edited in place instead of re-posted on each push.
async function upsertComment(github, owner, repo, issueNumber, result) {
  const comments = await github.paginate(github.rest.issues.listComments, {
    owner,
    repo,
    issue_number: issueNumber,
    per_page: 100,
  })
  const existing = comments.find(
    (c) => c.user?.login === BOT_LOGIN && c.body?.includes(MARKER)
  )
  // Nothing to say on a PR that was fine from the start.
  if (result.done && !existing) return

  const body = renderComment(result)
  if (existing) {
    if (existing.body === body) return
    await github.rest.issues.updateComment({
      owner,
      repo,
      comment_id: existing.id,
      body,
    })
  } else {
    await github.rest.issues.createComment({
      owner,
      repo,
      issue_number: issueNumber,
      body,
    })
  }
}

function renderComment({ done, missing, unlinked, claUrl }) {
  if (done) {
    return `${MARKER}\n**CLA:** all contributors have signed the [Contributor License Agreement](${claUrl}). Thank you!`
  }
  const lines = [
    MARKER,
    `**CLA:** thank you for your contribution! Before it can be merged, every contributor needs to sign our [Contributor License Agreement](${claUrl}) once. You keep the copyright in your work.`,
    "",
  ]
  if (missing.length > 0) {
    lines.push(
      "To sign, read the CLA and post this comment on this pull request:",
      "",
      "```",
      SIGN_PHRASE,
      "```",
      "",
      "Not signed yet:",
      ...missing.map((user) => `- [ ] @${user.login}`),
      ""
    )
  }
  if (unlinked.length > 0) {
    lines.push(
      "These commit authors are not linked to a GitHub account, so they cannot sign. Add the email address to your [GitHub account](https://github.com/settings/emails), or rewrite the commits with an email that is linked, then comment `recheck`:",
      "",
      ...unlinked.map((a) => `- ${code(a.name)} ${code(`<${a.email}>`)}`),
      ""
    )
  }
  lines.push(`Comment \`${RECHECK}\` to run the check again.`)
  return lines.join("\n")
}

module.exports.SIGN_PHRASE = SIGN_PHRASE
module.exports.MARKER = MARKER
