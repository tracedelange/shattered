// The event stream the orchestrator emits and the UI consumes. The whole point
// of the POC is observability: every tier call announces a node starting and a
// node finishing (with its output), so the kanban board fills in left-to-right.

export type Tier = 1 | 2 | 3;

export type ForgeEvent =
  | { type: 'run_start'; runId: string; zones: string[]; live: boolean }
  | { type: 'node_start'; tier: Tier; id: string; parentId?: string; label: string }
  | { type: 'node_done'; tier: Tier; id: string; parentId?: string; label: string; detail: unknown; artifactPath?: string }
  | { type: 'node_error'; tier: Tier; id: string; parentId?: string; message: string }
  | { type: 'run_done'; runId: string; regions: number; artifacts: number }
  | { type: 'run_stopped'; runId: string }
  | { type: 'run_error'; message: string };

export type Emit = (e: ForgeEvent) => void;
