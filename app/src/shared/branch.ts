import type { WorktreeInfo } from './types';

/** The branch a task's worktree is on now: the one it was created with, unless it switched since. */
export function branchLabel(wt: WorktreeInfo): string {
  if (wt.currentBranch === undefined) return wt.branch;
  return wt.currentBranch ?? 'detached HEAD';
}
