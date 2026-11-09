/** The shapes the build writes into assets/ (see content/SCHEMA.md and dev/build-content.mjs). */
import type { PracticeActivity } from '@mnemonexus/addon-sdk/practice';

/** What the catalogue's opaque `launch` holds: which engine, and its spec. */
export interface Launch { engine: string; spec: unknown }
export type CatalogueEntry = PracticeActivity & { launch: Launch & Record<string, unknown> };

/** What is kept for the list: how the last full run went. */
export interface DoneRecord { met: number; total: number; at: number; valid: boolean }
