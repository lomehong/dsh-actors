export declare const name = "dsh-actors";
export declare const provide: string[];
export declare function apply(ctx: unknown): void;
export { provision, resolve, bindMaster, setRole, addBinding, merge, list, stats, normalizeChannel, normalizeUserId } from './registry.ts';
export type { ActorEntity, ActorRole, ActorStore } from './registry.ts';
