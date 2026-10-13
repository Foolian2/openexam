import assert from "node:assert/strict"
import { test } from "node:test"
import cla from "../scripts/cla.cjs"

const OWNER = { login: "Foolian2", id: 1, type: "User" }
const ALICE = { login: "alice", id: 2, type: "User" }
const BOB = { login: "bob", id: 3, type: "User" }
const DEPENDABOT = { login: "dependabot[bot]", id: 4, type: "Bot" }

const commit = (author, name = author?.login, message = "change") => ({
  author,
  commit: { author: { name, email: `${name}@example.com` }, message },
})

function fakeGitHub({
  prAuthor,
  commits,
  signatures = null,
  comments = [],
  users = [],
  totalCommits = commits.length,
}) {
  const state = {
    statuses: [],
    comments: [...comments],
    files: signatures ? { sha: "s1", signatures } : null,
    branch: signatures !== null,
    writes: 0,
  }
  const notFound = () => Object.assign(new Error("Not Found"), { status: 404 })
  const github = {
    paginate: async (method, args) => method(args).then((r) => r.data),
    rest: {
      pulls: {
        get: async () => ({
          data: {
            number: 7,
            state: "open",
            commits: totalCommits,
            user: prAuthor,
            head: { sha: "head" },
          },
        }),
        listCommits: async () => ({ data: commits }),
      },
      repos: {
        createCommitStatus: async (args) => state.statuses.push(args),
        getContent: async () => {
          if (!state.files) throw notFound()
          const json = JSON.stringify({ signatures: state.files.signatures })
          return {
            data: {
              sha: state.files.sha,
              content: Buffer.from(json).toString("base64"),
            },
          }
        },
        createOrUpdateFileContents: async (args) => {
          state.writes++
          const json = Buffer.from(args.content, "base64").toString("utf8")
          state.files = { sha: "s2", signatures: JSON.parse(json).signatures }
        },
      },
      git: {
        getRef: async () => {
          if (!state.branch) throw notFound()
          return { data: {} }
        },
        createTree: async ({ tree }) => {
          state.files = {
            sha: "s1",
            signatures: JSON.parse(tree[0].content).signatures,
          }
          return { data: { sha: "tree" } }
        },
        createCommit: async ({ parents }) => {
          assert.deepEqual(parents, [])
          return { data: { sha: "commit" } }
        },
        createRef: async ({ ref }) => {
          assert.equal(ref, "refs/heads/cla-signatures")
          state.writes++
          state.branch = true
        },
      },
      users: {
        getByUsername: async ({ username }) => {
          const user = users.find((u) => u.login === username)
          if (!user) throw notFound()
          return { data: user }
        },
      },
      search: {
        users: async ({ q }) => {
          const items = users.filter((u) => q === `${u.email} in:email`)
          return { data: { total_count: items.length, items } }
        },
      },
      issues: {
        listComments: async () => ({ data: state.comments }),
        createComment: async ({ body }) =>
          state.comments.push({
            id: state.comments.length + 1,
            body,
            user: { login: "github-actions[bot]", type: "Bot" },
          }),
        updateComment: async ({ comment_id, body }) => {
          state.comments.find((c) => c.id === comment_id).body = body
        },
      },
    },
  }
  return { github, state }
}

const core = { info() {} }
const repo = { owner: "Foolian2", repo: "openexam" }
const prEvent = {
  repo,
  eventName: "pull_request_target",
  payload: { action: "opened", pull_request: { number: 7 } },
}
const commentEvent = (user, body) => ({
  repo,
  eventName: "issue_comment",
  payload: {
    issue: { number: 7, pull_request: {} },
    comment: { user, body, html_url: "https://example.com/c" },
  },
})
const lastStatus = (state) => state.statuses.at(-1).state

test("maintainer PRs pass without a CLA, even with unlinked AI commits", async () => {
  const { github, state } = fakeGitHub({
    prAuthor: OWNER,
    commits: [commit(OWNER), commit(null, "Claude")],
  })
  await cla({ github, context: prEvent, core })
  assert.equal(lastStatus(state), "success")
  assert.equal(state.comments.length, 0)
})

test("an outside contributor gets a failing status and one comment", async () => {
  const { github, state } = fakeGitHub({
    prAuthor: ALICE,
    commits: [commit(ALICE), commit(DEPENDABOT)],
  })
  await cla({ github, context: prEvent, core })
  await cla({ github, context: prEvent, core })
  assert.equal(lastStatus(state), "failure")
  assert.equal(state.comments.length, 1)
  assert.match(state.comments[0].body, /@alice/)
  assert.doesNotMatch(state.comments[0].body, /dependabot/)
})

test("signing creates the signatures branch and turns the check green", async () => {
  const { github, state } = fakeGitHub({
    prAuthor: ALICE,
    commits: [commit(ALICE)],
  })
  await cla({ github, context: prEvent, core })
  await cla({
    github,
    context: commentEvent(ALICE, `  ${cla.SIGN_PHRASE.toUpperCase()} `),
    core,
  })
  assert.equal(state.branch, true)
  assert.deepEqual(
    state.files.signatures.map((s) => [s.id, s.login]),
    [[2, "alice"]]
  )
  assert.equal(lastStatus(state), "success")
  assert.match(state.comments[0].body, /all contributors have signed/)
})

test("a signature carries over to later PRs and is matched by user id", async () => {
  const { github, state } = fakeGitHub({
    prAuthor: { ...ALICE, login: "alice-renamed" },
    commits: [commit(ALICE)],
    signatures: [{ id: 2, login: "alice" }],
  })
  await cla({ github, context: prEvent, core })
  assert.equal(lastStatus(state), "success")
  assert.equal(state.comments.length, 0)
})

test("only contributors to the PR can sign on it", async () => {
  const { github, state } = fakeGitHub({
    prAuthor: ALICE,
    commits: [commit(ALICE)],
    signatures: [],
  })
  await cla({ github, context: commentEvent(BOB, cla.SIGN_PHRASE), core })
  assert.equal(state.writes, 0)
  assert.equal(lastStatus(state), "failure")
})

test("unlinked commit authors keep the check red, with escaped names", async () => {
  const { github, state } = fakeGitHub({
    prAuthor: ALICE,
    commits: [commit(ALICE), commit(null, "@everyone `x`")],
    signatures: [{ id: 2, login: "alice" }],
  })
  await cla({ github, context: prEvent, core })
  assert.equal(lastStatus(state), "failure")
  assert.match(state.comments[0].body, /`@everyone x`/)
  assert.doesNotMatch(state.comments[0].body, /Not signed yet/)
})

test("other comments and non-PR issues are ignored", async () => {
  const { github, state } = fakeGitHub({
    prAuthor: ALICE,
    commits: [commit(ALICE)],
  })
  await cla({ github, context: commentEvent(ALICE, "looks good"), core })
  const issueEvent = commentEvent(ALICE, cla.SIGN_PHRASE)
  delete issueEvent.payload.issue.pull_request
  await cla({ github, context: issueEvent, core })
  assert.equal(state.statuses.length, 0)
})

test("co-authors must sign too, resolved by noreply address or public email", async () => {
  const carol = { login: "carol", id: 5, type: "User", email: "carol@uni.ch" }
  const { github, state } = fakeGitHub({
    prAuthor: ALICE,
    commits: [
      commit(
        ALICE,
        "alice",
        [
          "feat: x",
          "",
          "Co-authored-by: Bob <3+bob@users.noreply.github.com>",
          "co-authored-by: Carol <carol@uni.ch>",
          "Co-Authored-By: Claude <noreply@anthropic.com>",
        ].join("\n")
      ),
    ],
    signatures: [{ id: 2, login: "alice" }],
    users: [BOB, carol],
  })
  await cla({ github, context: prEvent, core })
  assert.equal(lastStatus(state), "failure")
  assert.match(state.comments[0].body, /@bob/)
  assert.match(state.comments[0].body, /@carol/)
  assert.doesNotMatch(state.comments[0].body, /Claude|anthropic/)
})

test("a co-author email that matches no account fails closed", async () => {
  const { github, state } = fakeGitHub({
    prAuthor: ALICE,
    commits: [
      commit(ALICE, "alice", "fix\n\nCo-authored-by: Dan <dan@example.org>"),
    ],
    signatures: [{ id: 2, login: "alice" }],
  })
  await cla({ github, context: prEvent, core })
  assert.equal(lastStatus(state), "failure")
  assert.match(state.comments[0].body, /`<dan@example.org>`/)
})

test("PRs over the 250-commit API limit fail closed", async () => {
  const { github, state } = fakeGitHub({
    prAuthor: ALICE,
    commits: [commit(ALICE)],
    signatures: [{ id: 2, login: "alice" }],
    totalCommits: 251,
  })
  await cla({ github, context: prEvent, core })
  assert.equal(lastStatus(state), "failure")
})

test("edits re-check only when the base branch changed", async () => {
  const { github, state } = fakeGitHub({
    prAuthor: ALICE,
    commits: [commit(ALICE)],
  })
  const edited = (changes) => ({
    ...prEvent,
    payload: { ...prEvent.payload, action: "edited", changes },
  })
  await cla({ github, context: edited({ title: { from: "x" } }), core })
  assert.equal(state.statuses.length, 0)
  await cla({ github, context: edited({ base: { ref: { from: "x" } } }), core })
  assert.equal(lastStatus(state), "failure")
})

test("a marker comment from another bot is not taken over", async () => {
  const { github, state } = fakeGitHub({
    prAuthor: ALICE,
    commits: [commit(ALICE)],
    comments: [
      {
        id: 1,
        body: `quoting ${cla.MARKER}`,
        user: { login: "other[bot]", type: "Bot" },
      },
    ],
  })
  await cla({ github, context: prEvent, core })
  assert.equal(state.comments.length, 2)
  assert.equal(state.comments[0].body, `quoting ${cla.MARKER}`)
})
