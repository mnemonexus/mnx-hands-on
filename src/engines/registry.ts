/** The engines, found by id. Built from the exports of engines/index.ts, so adding an engine there is all it takes. */
import type { AnyEngine } from '../engine';
import * as exported from './index';

export const engines: Record<string, AnyEngine> = Object.fromEntries(Object.values(exported as Record<string, AnyEngine>).map((engine) => [engine.id, engine]));
export const engineList: AnyEngine[] = Object.values(engines);
