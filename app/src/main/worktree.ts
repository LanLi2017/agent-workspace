import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { BranchList, WorktreeInfo } from '../shared/types';
import { run } from './util/exec';

// Per-task git worktrees isolate concurrent edits. They are NOT a security
// boundary; provider sandboxes and approvals remain the boundary.

export async function gitRoot(path: string): Promise<string | null> {
  const r = await run('git', ['-C', path, 'rev-parse', '--show-toplevel']);
  return r.code === 0 ? r.stdout.trim() : null;
}

export class WorktreeService {
  constructor(private baseDir: string) {}

  /** Local branches, the one checked out in the project folder, and which are in use by any worktree. */
  async branches(repoRoot: string): Promise<BranchList> {
    const [refs, current, list] = await Promise.all([
      run('git', ['-C', repoRoot, 'for-each-ref', '--sort=-committerdate', '--format=%(refname:short)', 'refs/heads']),
      run('git', ['-C', repoRoot, 'symbolic-ref', '--short', '-q', 'HEAD']),
      run('git', ['-C', repoRoot, 'worktree', 'list', '--porcelain']),
    ]);
    if (refs.code !== 0) throw new Error(`Could not list branches: ${refs.stderr.trim()}`);
    const inUse = new Set(list.stdout.split('\n').filter((l) => l.startsWith('branch refs/heads/')).map((l) => l.slice('branch refs/heads/'.length)));
    return {
      current: current.code === 0 ? current.stdout.trim() || null : null,
      branches: refs.stdout.split('\n').filter(Boolean).map((name) => ({ name, checkedOut: inUse.has(name) })),
    };
  }

  /**
   * A new worktree for a task. By default it gets a fresh `amw/<slug>` branch from the
   * project folder's HEAD; `from` starts that branch from another local branch instead, and
   * `useExisting` checks `from` itself out (git refuses if another worktree has it).
   */
  async create(repoRoot: string, projectId: string, slug: string, opts: { from?: string; useExisting?: boolean } = {}): Promise<WorktreeInfo> {
    const from = opts.from?.trim();
    if (opts.useExisting && !from) throw new Error('Choose the branch to work on.');
    if (from) await this.checkBranch(repoRoot, from);
    const head = await run('git', ['-C', repoRoot, 'rev-parse', '--verify', '--quiet', from ? `refs/heads/${from}^{commit}` : 'HEAD']);
    if (head.code !== 0) throw new Error(from ? `There is no local branch "${from}".` : 'The repository has no commits yet, so a worktree cannot be created.');
    const baseRef = head.stdout.trim();
    const path = join(this.baseDir, projectId, slug);
    mkdirSync(dirname(path), { recursive: true });
    const branch = opts.useExisting ? from! : `amw/${slug}`;
    const args = opts.useExisting ? ['worktree', 'add', path, branch] : ['worktree', 'add', '-b', branch, path, baseRef];
    const r = await run('git', ['-C', repoRoot, ...args]);
    if (r.code !== 0) throw new Error(`git worktree add failed: ${r.stderr.trim() || r.stdout.trim()}`);
    return { path, branch, baseRef, parentRepo: repoRoot, ownsBranch: !opts.useExisting };
  }

  /** The branch checked out in a worktree now (an agent or the user may have switched), or null when detached. */
  async currentBranch(path: string): Promise<string | null> {
    const r = await run('git', ['-C', path, 'symbolic-ref', '--short', '-q', 'HEAD']);
    return r.code === 0 ? r.stdout.trim() || null : null;
  }

  private async checkBranch(repoRoot: string, name: string): Promise<void> {
    const r = name.startsWith('-') ? { code: 1 } : await run('git', ['-C', repoRoot, 'check-ref-format', '--branch', name]);
    if (r.code !== 0) throw new Error(`"${name}" is not a valid branch name.`);
  }

  /** Why the worktree must be kept, or null when it is safe to remove. */
  async keepReason(info: WorktreeInfo): Promise<string | null> {
    const status = await run('git', ['-C', info.path, 'status', '--porcelain']);
    if (status.code !== 0) return `cannot read git status (${status.stderr.trim()})`;
    if (status.stdout.trim()) return 'it has uncommitted changes';
    const ahead = await run('git', ['-C', info.path, 'rev-list', '--count', `${info.baseRef}..HEAD`]);
    if (ahead.code === 0 && Number(ahead.stdout.trim()) > 0) return `branch ${info.branch} has commits not in the base`;
    return null;
  }

  /** Removes only a clean worktree with no new commits; never forces. */
  async removeIfClean(info: WorktreeInfo): Promise<{ removed: boolean; reason?: string }> {
    const reason = await this.keepReason(info);
    if (reason) return { removed: false, reason };
    const r = await run('git', ['-C', info.parentRepo, 'worktree', 'remove', info.path]);
    if (r.code !== 0) return { removed: false, reason: r.stderr.trim() };
    // A branch the user picked to work on is theirs; only a branch made for the task is deleted.
    if (info.ownsBranch !== false) await run('git', ['-C', info.parentRepo, 'branch', '-d', info.branch]);
    return { removed: true };
  }
}
