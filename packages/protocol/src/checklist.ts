import { z } from 'zod';

/**
 * The dev-overlay checklist (todo item 46b, W11-1): an agent writes a list of test/review steps
 * through `wtm checklist set`, the overlay shows them as checkboxes, and the user checking one in
 * the browser writes `checked` back into WTM's state DB. Follows the same wire-shape pattern
 * `task-overrides.ts` established for item 49's task-record surface, per item 46's own note that
 * the checklist should reuse that pattern rather than invent a second one.
 */

/**
 * A `checklist.set` item's text, checked the same way the store
 * (`packages/core/src/state/checklist-store.ts`) will use it: trimmed. `checklist.set` replaces
 * the whole list unconditionally (it deletes every existing row before inserting), so an item
 * that is only whitespace -- passing the plain `.min(1)` bound on its raw, untrimmed length --
 * used to reach the store, get trimmed to `""`, and get filtered out there, silently wiping any
 * prior checklist down to zero items with no warning and no error. Checking the trimmed length
 * here, before that delete ever runs, turns that into an ordinary WTM_DAEMON_INVALID_REQUEST
 * instead.
 */
const checklistItemTextSchema = z.string().min(1).max(500)
  .refine((value) => value.trim().length > 0, { message: 'A checklist item must not be only whitespace.' });

export const checklistItemSchema = z.object({
  position: z.number().int().min(0),
  text: z.string().min(1).max(500),
  checked: z.boolean(),
  createdAt: z.string().min(1).max(64),
  updatedAt: z.string().min(1).max(64),
}).strict();
export type ChecklistItemWire = z.infer<typeof checklistItemSchema>;

/** The daemon-socket IPC commands: agent/CLI-facing, reachable only through the local socket. */
export const checklistArgumentSchemas = {
  'checklist.list': z.object({ cwd: z.string().min(1).max(4096) }).strict(),
  'checklist.set': z.object({
    cwd: z.string().min(1).max(4096),
    items: z.array(checklistItemTextSchema).min(1).max(100),
  }).strict(),
  'checklist.clear': z.object({ cwd: z.string().min(1).max(4096) }).strict(),
} as const;
export const checklistCommandNames: ReadonlySet<string> = new Set(Object.keys(checklistArgumentSchemas));
export type ChecklistCommand = keyof typeof checklistArgumentSchemas;

export const checklistListResultSchema = z.object({ items: z.array(checklistItemSchema) }).strict();
export const checklistSetResultSchema = z.object({ items: z.array(checklistItemSchema) }).strict();
export const checklistClearResultSchema = z.object({ removed: z.number().int().min(0) }).strict();

/**
 * The browser's own toggle request, sent as a plain JSON POST body to the proxy's built-in
 * `/__wtm/checklist` endpoint — this is NOT one of the daemon-socket IPC commands above (a
 * browser can never reach the Unix socket, only the proxy's loopback HTTP listener), so it is not
 * part of `checklistArgumentSchemas`/`checklistCommandNames`. It is the overlay's own HTTP
 * contract, handled directly by `ProxyServer`'s `overlayApi` hook
 * (`packages/daemon/src/proxy.ts`, `packages/daemon/src/dev-overlay.ts`).
 */
export const checklistToggleRequestSchema = z.object({
  position: z.number().int().min(0),
  checked: z.boolean(),
}).strict();
export type ChecklistToggleRequest = z.infer<typeof checklistToggleRequestSchema>;
