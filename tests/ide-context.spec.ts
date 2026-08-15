import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import AgentRegistry, { agentEvents, Inbox, type Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import * as ideContext from '@deepseek-ai/dsh-ide-context'
import type { IdeSnapshot } from '@deepseek-ai/dsh-ide-context'
import { IdeBridge } from '@deepseek-ai/dsh-ide-context'

const SIGNAL = new AbortController().signal

/** Minimal logger accepted by scanLatestLock and the bridge. */
const quietLogger = {
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
  success: vi.fn(),
} as unknown as Context['logger']

function snapshot(overrides: Partial<IdeSnapshot> = {}): IdeSnapshot {
  return {
    ideName: 'IntelliJ IDEA',
    workspaceFolders: ['/work/project'],
    openedFiles: ['/work/project/src/Main.java', '/work/project/pom.xml'],
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Lock-file discovery
// ---------------------------------------------------------------------------

describe('scanLatestLock', () => {
  let dir: string
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }) })

  function lockFile(name: string, content: unknown): void {
    writeFileSync(join(dir, name), JSON.stringify(content))
  }

  it('picks the newest lock file and parses port, token and metadata', () => {
    dir = mkdtempSync(join(tmpdir(), 'ide-context-'))
    lockFile('1000.lock', { ideName: 'IntelliJ IDEA', pid: 1, authToken: 'old', workspaceFolders: ['/a'] })
    lockFile('2000.lock', { ideName: 'Visual Studio Code', pid: 2, authToken: 'new-token', workspaceFolders: ['/b', '/c'] })
    const lock = ideContext.scanLatestLock(dir, quietLogger)
    expect(lock).toMatchObject({ port: 2000, ideName: 'Visual Studio Code', pid: 2, authToken: 'new-token' })
    expect(lock?.workspaceFolders).toEqual(['/b', '/c'])
  })

  it('returns undefined for a missing directory', () => {
    expect(ideContext.scanLatestLock(join(tmpdir(), 'does-not-exist-xyz'), quietLogger)).toBeUndefined()
  })

  it('returns undefined for an empty directory', () => {
    dir = mkdtempSync(join(tmpdir(), 'ide-context-'))
    expect(ideContext.scanLatestLock(dir, quietLogger)).toBeUndefined()
  })

  it('skips lock files without an auth token', () => {
    dir = mkdtempSync(join(tmpdir(), 'ide-context-'))
    lockFile('3000.lock', { ideName: 'IntelliJ IDEA' })
    expect(ideContext.scanLatestLock(dir, quietLogger)).toBeUndefined()
  })
})

describe('selectLockByWorkspace', () => {
  let dir: string
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }) })

  function candidate(name: string, workspaceFolders: string[], mtime: number) {
    return {
      path: join(dir, name),
      mtime,
      lock: {
        port: Number(name.replace('.lock', '')),
        ideName: 'Visual Studio Code',
        pid: 1,
        workspaceFolders,
        authToken: 'token',
      },
    }
  }

  it('prefers the newest lock whose workspace folder equals the cwd', () => {
    dir = mkdtempSync(join(tmpdir(), 'ide-context-'))
    const olderMatch = candidate('1000.lock', ['/proj'], 1000)
    const newerOther = candidate('2000.lock', ['/other'], 2000)
    const selected = ideContext.selectLockByWorkspace([newerOther, olderMatch], '/proj')
    expect(selected?.lock.port).toBe(1000)
  })

  it('falls back to the newest lock when no workspace matches', () => {
    dir = mkdtempSync(join(tmpdir(), 'ide-context-'))
    const newest = candidate('2000.lock', ['/other'], 2000)
    const selected = ideContext.selectLockByWorkspace([newest], '/proj')
    expect(selected?.lock.port).toBe(2000)
  })

  it('falls back to the newest lock when cwd is undefined', () => {
    dir = mkdtempSync(join(tmpdir(), 'ide-context-'))
    const newest = candidate('2000.lock', ['/proj'], 2000)
    const selected = ideContext.selectLockByWorkspace([newest], undefined)
    expect(selected?.lock.port).toBe(2000)
  })

  it('prefers the lock whose workspace folder contains the cwd (subdirectory match)', () => {
    dir = mkdtempSync(join(tmpdir(), 'ide-context-'))
    const containsCwd = candidate('1000.lock', ['/proj'], 1000)
    const newerOther = candidate('2000.lock', ['/elsewhere'], 2000)
    const selected = ideContext.selectLockByWorkspace([newerOther, containsCwd], '/proj/src/main')
    expect(selected?.lock.port).toBe(1000)
  })

  it('does not treat a sibling directory (prefix collision) as a match', () => {
    dir = mkdtempSync(join(tmpdir(), 'ide-context-'))
    const sibling = candidate('1000.lock', ['/proj-other'], 1000)
    const selected = ideContext.selectLockByWorkspace([sibling], '/proj')
    expect(selected?.lock.port).toBe(1000) // no exact/subdir match -> newest (only) lock
  })
})

describe('filterFilesUnderRoots', () => {
  it('keeps files under a root and drops siblings and unrelated trees', () => {
    const roots = ['/proj']
    const files = ['/proj/a.js', '/proj/sub/b.js', '/proj-other/c.js', '/elsewhere/d.js']
    expect(ideContext.filterFilesUnderRoots(files, roots)).toEqual(['/proj/a.js', '/proj/sub/b.js'])
  })

  it('keeps everything when roots is empty', () => {
    expect(ideContext.filterFilesUnderRoots(['/a', '/b'], [])).toEqual(['/a', '/b'])
  })
})

describe('IdeBridge.followWorkspace rebuilding', () => {
  let dir: string
  let bridge: IdeBridge
  afterEach(() => {
    bridge?.dispose()
    if (dir) rmSync(dir, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  function lockFile(port: number, workspaceFolders: string[], mtimeAdvance = 0): void {
    const content = {
      pid: 1,
      workspaceFolders,
      ideName: 'Visual Studio Code',
      authToken: `token-${port}`,
    }
    writeFileSync(join(dir, `${port}.lock`), JSON.stringify(content))
    // Bump mtime so newest-first ordering is deterministic across rewrites.
    const target = new Date(Date.now() + mtimeAdvance * 1000)
    utimesSync(join(dir, `${port}.lock`), target, target)
  }

  it('rebuilds when the same port\'s workspaceFolders change (switch back to the project)', () => {
    dir = mkdtempSync(join(tmpdir(), 'ide-context-'))
    lockFile(65291, ['/Users/lsai/workspace/project-a'])
    bridge = new IdeBridge(dir, 5000, quietLogger)
    const connect = vi.spyOn(IdeBridge.prototype as never, 'connect' as never)

    // Initial adoption for project A.
    bridge.followWorkspace('/Users/lsai/workspace/project-a')
    const firstCalls = connect.mock.calls.length

    // Simulate the same VS Code window switching to project B: same port,
    // different workspaceFolders content in the lock file.
    lockFile(65291, ['/Users/lsai/workspace/project-b'], 1000)
    bridge.followWorkspace('/Users/lsai/workspace/project-b')

    // The bridge must re-adopt (reconnect) despite the port being unchanged.
    expect(connect.mock.calls.length).toBeGreaterThan(firstCalls)

    // Switch back to A with the same port again — must rebuild again.
    lockFile(65291, ['/Users/lsai/workspace/project-a'], 2000)
    const beforeReturn = connect.mock.calls.length
    bridge.followWorkspace('/Users/lsai/workspace/project-a')
    expect(connect.mock.calls.length).toBeGreaterThan(beforeReturn)
  })

  it('does not reconnect when the same port and folders are re-selected', () => {
    dir = mkdtempSync(join(tmpdir(), 'ide-context-'))
    lockFile(65291, ['/Users/lsai/workspace/project-a'])
    bridge = new IdeBridge(dir, 5000, quietLogger)
    const connect = vi.spyOn(IdeBridge.prototype as never, 'connect' as never)

    bridge.followWorkspace('/Users/lsai/workspace/project-a')
    const afterFirst = connect.mock.calls.length
    bridge.followWorkspace('/Users/lsai/workspace/project-a')
    bridge.followWorkspace('/Users/lsai/workspace/project-a')

    expect(connect.mock.calls.length).toBe(afterFirst)
  })
})

// ---------------------------------------------------------------------------
// Tool-result parsing (both IDE dialects)
// ---------------------------------------------------------------------------

describe('opened-files extraction', () => {
  it('parses a newline-separated list (IntelliJ get_all_opened_file_paths)', () => {
    const result = { content: [{ type: 'text', text: '/a/b.java\n/c/d.ts\n' }] }
    expect(ideContext.extractOpenedFiles(result)).toEqual(['/a/b.java', '/c/d.ts'])
  })

  it('parses a JSON array of paths', () => {
    const result = { content: [{ type: 'text', text: '["/a/b.java","/c/d.ts"]' }] }
    expect(ideContext.extractOpenedFiles(result)).toEqual(['/a/b.java', '/c/d.ts'])
  })

  it('parses the VS Code getOpenEditors tabs object (uri + fileName entries)', () => {
    const payload = JSON.stringify({
      tabs: [
        { uri: 'file:///a/b.java', isActive: false },
        { uri: 'file:///c/d.ts', fileName: '/c/d.ts', isActive: true },
      ],
    })
    const result = { content: [{ type: 'text', text: payload }] }
    expect(ideContext.extractOpenedFiles(result)).toEqual(['/a/b.java', '/c/d.ts'])
  })

  it('decodes file:// uris and prefers fileName when present', () => {
    const payload = JSON.stringify({
      tabs: [
        { uri: 'file:///Users/x/a%20b.ts' },
        { uri: 'file:///wrong.ts', fileName: '/Users/x/real.ts' },
      ],
    })
    const result = { content: [{ type: 'text', text: payload }] }
    expect(ideContext.extractOpenedFiles(result)).toEqual(['/Users/x/a b.ts', '/Users/x/real.ts'])
  })

  it('returns an empty list for an empty tabs object (no editors open)', () => {
    const result = { content: [{ type: 'text', text: '{"tabs":[]}' }] }
    expect(ideContext.extractOpenedFiles(result)).toEqual([])
  })

  it('drops virtual-document URIs (git:, output:) while keeping real files', () => {
    const payload = JSON.stringify({
      tabs: [
        { uri: 'file:///a/real.js' },
        { fileName: '/a/real2.ts' },
        { uri: 'git:/a/README.md?%7B%22path%22%3A%22x%22%7D' },
        { uri: 'output:renderer' },
      ],
    })
    const result = { content: [{ type: 'text', text: payload }] }
    expect(ideContext.extractOpenedFiles(result)).toEqual(['/a/real.js', '/a/real2.ts'])
  })

  it('returns undefined when the result has no usable text', () => {
    expect(ideContext.extractOpenedFiles({ content: [] })).toBeUndefined()
    expect(ideContext.extractOpenedFiles(undefined)).toBeUndefined()
  })
})

describe('selection extraction', () => {
  it('parses a getCurrentSelection result with full text', () => {
    const payload = JSON.stringify({
      success: true,
      filePath: '/work/src/Main.java',
      selection: { start: { line: 3, character: 1 }, end: { line: 5, character: 9 } },
      text: 'selected\nlines',
    })
    const result = { content: [{ type: 'text', text: payload }] }
    expect(ideContext.extractSelectionToolResult(result)).toEqual({
      filePath: '/work/src/Main.java',
      start: { line: 3, character: 1 },
      end: { line: 5, character: 9 },
      text: 'selected\nlines',
    })
  })

  it('treats a missing selection as an empty caret selection', () => {
    const payload = JSON.stringify({ success: true, filePath: '/work/src/Main.java' })
    const result = { text: payload }
    expect(ideContext.extractSelectionToolResult(result)).toEqual({
      filePath: '/work/src/Main.java',
      start: { line: 0, character: 0 },
      end: { line: 0, character: 0 },
      text: '',
    })
  })
})

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

describe('rendering', () => {
  it('renders opened files and the selection', () => {
    const state = ideContext.renderState(snapshot({
      openedFiles: ['/work/src/Main.java'],
      selection: {
        filePath: '/work/src/Main.java',
        start: { line: 3, character: 1 },
        end: { line: 5, character: 9 },
        text: 'selected',
      },
    }))
    expect(state).toContain('ide: IntelliJ IDEA')
    expect(state).toContain('opened files (1):')
    expect(state).toContain('- /work/src/Main.java')
    expect(state).toContain('The user selected lines 4 to 6 from /work/src/Main.java:')
    expect(state).toContain('selected')
    expect(state).toContain('This may or may not be related to the current task.')
  })

  it('renders a single-line selection with the singular "line" wording', () => {
    const state = ideContext.renderState(snapshot({
      selection: {
        filePath: '/work/src/Main.java',
        start: { line: 8, character: 0 },
        end: { line: 8, character: 4 },
        text: 'code',
      },
    }))
    expect(state).toContain('The user selected line 9 from /work/src/Main.java:')
    expect(state).toContain('code')
  })

  it('omits an empty caret selection', () => {
    const state = ideContext.renderState(snapshot({
      selection: { filePath: '/work/src/Main.java', start: { line: 0, character: 0 }, end: { line: 0, character: 0 }, text: '' },
    }))
    expect(state).not.toContain('The user selected')
  })
})

// ---------------------------------------------------------------------------
// agent/pre-step injection
// ---------------------------------------------------------------------------

type IdeContextStub = { latest: () => IdeSnapshot | undefined; followWorkspace: (cwd: string | undefined) => void }

function sessionAgent(session: Session, id = 'agent'): Agent {
  return {
    id: SessionId(id),
    options: {},
    session,
    inbox: new Inbox(session, { inserted: () => {}, discarded: () => {}, claimed: () => {} }),
    status: 'running',
    ctx: new Context(),
    send: () => {},
    followup: () => {},
    steer: () => {},
    inject: () => { throw new Error('ide-context must append directly to the open step') },
    cancel() {},
    runMaintenance: task => task(new AbortController().signal),
    whenIdle: () => Promise.resolve(),
  }
}

function openMessageTurn(session: Session, turn: number): void {
  session.append('turn/start', { turn })
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: `turn ${turn}` }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
}

function contextTexts(session: Session): string[] {
  const texts: string[] = []
  for (const event of session.events) {
    if (event.type === 'user/message'
      && event.data.source.kind === 'plugin'
      && event.data.source.plugin === 'ide-context') {
      texts.push(event.data.content.find(block => block.type === 'text')?.text ?? '')
    }
  }
  return texts
}

async function fire(
  ctx: Context,
  agent: Agent,
  turn: number,
  step: number,
  signal: AbortSignal = SIGNAL,
): Promise<void> {
  const decision = await agentEvents(ctx, agent).waterfall(
    'agent/pre-step',
    { messages: [], turn, step, signal },
    () => Promise.resolve({ kind: 'enter' as const, messages: [] }),
  )
  if (decision.kind === 'enter') {
    for (const message of decision.messages) {
      agent.session.append('user/message', message, { surfaceOp: 'append' })
    }
  }
}

async function mount(snap: IdeSnapshot | undefined, config: Record<string, unknown> = {}): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(AgentRegistry)
  ctx.provide('ideContext', { latest: () => snap, followWorkspace: () => {} } as never)
  await ctx.plugin(ideContext, config)
  return ctx
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('ide-context injection', () => {
  it('injects the IDE snapshot on the first step of a turn', async () => {
    const ctx = await mount(snapshot())
    const session = Session.create(SessionId('first'))
    openMessageTurn(session, 1)

    await fire(ctx, sessionAgent(session), 1, 1)

    const texts = contextTexts(session)
    expect(texts).toHaveLength(1)
    expect(texts[0]).toContain('ide context (turn 1):')
    expect(texts[0]).toContain('- /work/project/src/Main.java')
    const event = session.events.at(-1)
    if (event?.type !== 'user/message') throw new Error('missing ide context')
    expect(event.data.source).toMatchObject({
      kind: 'plugin',
      plugin: 'ide-context',
      form: 'snapshot',
      sections: [{ name: 'ide-context' }],
    })
    expect(event.surfaceOp).toBe('append')
  })

  it('does not inject on later steps of the same turn', async () => {
    const ctx = await mount(snapshot())
    const session = Session.create(SessionId('steps'))
    openMessageTurn(session, 1)

    await fire(ctx, sessionAgent(session), 1, 1)
    await fire(ctx, sessionAgent(session), 1, 2)

    expect(contextTexts(session)).toHaveLength(1)
  })

  it('does not inject again while the rendered state is unchanged', async () => {
    const ctx = await mount(snapshot())
    const session = Session.create(SessionId('stable'))
    openMessageTurn(session, 1)
    openMessageTurn(session, 2)

    await fire(ctx, sessionAgent(session), 1, 1)
    await fire(ctx, sessionAgent(session), 2, 1)

    expect(contextTexts(session)).toHaveLength(1)
  })

  it('re-injects when the selection changed', async () => {
    const snap = snapshot()
    const ctx = new Context()
    await ctx.plugin(AgentRegistry)
    let current: IdeSnapshot = snap
    ctx.provide('ideContext', { latest: () => current, followWorkspace: () => {} } as IdeContextStub as never)
    await ctx.plugin(ideContext, {})
    const session = Session.create(SessionId('changed'))
    openMessageTurn(session, 1)
    openMessageTurn(session, 2)

    await fire(ctx, sessionAgent(session), 1, 1)
    current = {
      ...snap,
      selection: {
        filePath: '/work/project/src/Main.java',
        start: { line: 9, character: 0 },
        end: { line: 10, character: 2 },
        text: 'new selection',
      },
    }
    await fire(ctx, sessionAgent(session), 2, 1)

    const texts = contextTexts(session)
    expect(texts).toHaveLength(2)
    expect(texts[1]).toContain('The user selected lines 10 to 11 from /work/project/src/Main.java:')
    expect(texts[1]).toContain('new selection')
  })

  it('is a no-op without any IDE data', async () => {
    const ctx = await mount(undefined)
    const session = Session.create(SessionId('none'))
    openMessageTurn(session, 1)

    await fire(ctx, sessionAgent(session), 1, 1)

    expect(contextTexts(session)).toHaveLength(0)
  })
})
