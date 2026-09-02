export type ActorRole = 'master' | 'colleague' | 'customer' | 'stranger' | 'blocked';
export declare const ACTOR_ROLES: readonly ActorRole[];
/** 一个实体可绑定多个渠道身份；channel 归一为小写 */
export interface ChannelBinding {
    channel: string;
    userId: string;
    boundAt: string;
}
export interface ActorEntity {
    /** act_<时间戳>_<随机> */
    id: string;
    createdAt: string;
    role: ActorRole;
    displayName?: string;
    note?: string;
    bindings: ChannelBinding[];
    /** 归并标记：本实体的身份已并入目标实体（历史保留，解析时跳转） */
    mergedInto?: string;
}
export interface ActorStore {
    /** 每次成功保存 +1，用于乐观并发检测与调试 */
    revision: number;
    entities: ActorEntity[];
}
export declare function actorHome(): string;
/** 渠道名归一：小写、去空白；userId 清除控制字符并限长 */
export declare function normalizeChannel(channel: unknown): string;
export declare function normalizeUserId(userId: unknown): string;
/** 加载注册表；文件缺失/损坏时返回空表（损坏文件留 .corrupt-* 备份可人工恢复） */
export declare function loadRegistry(): ActorStore;
/** 原子保存（临时文件 + rename，0600） */
export declare function saveRegistry(store: ActorStore): void;
/** 沿 mergedInto 链解析到存活实体（带环保护，链长上限 8） */
export declare function resolveAlias(store: ActorStore, entity: ActorEntity): ActorEntity;
/** 按渠道身份精确查找绑定（含被归并实体的别名绑定） */
export declare function findByChannelIdentity(store: ActorStore, channel: string, userId: string): ActorEntity | undefined;
export interface ProvisionResult {
    entity: ActorEntity;
    /** 本次是否新建（新建一律 stranger，绝不推断身份） */
    created: boolean;
}
/**
 * 解析或供给：已绑定 → 返回实体；未绑定 → 新建 stranger 实体并绑定。
 * 这是通道入口的唯一路径——身份永远由本注册表锚定，不接受对话者自述。
 */
export declare function provision(channel: unknown, userId: unknown, displayName?: unknown): ProvisionResult;
/** 解析（不新建）；未注册返回 null——调用方按 fail-closed 处理 */
export declare function resolve(channel: unknown, userId: unknown): ActorEntity | null;
export declare function getEntity(entityId: string): ActorEntity | null;
export interface BindMasterResult {
    ok: boolean;
    entity?: ActorEntity;
    error?: string;
}
/**
 * 主人认领：全局唯一 master。已存在其他 master 时拒绝（需先显式让位），
 * 同一实体重复认领幂等成功。认领同时建立渠道绑定。
 */
export declare function bindMaster(channel: unknown, userId: unknown): BindMasterResult;
export interface SetRoleResult {
    ok: boolean;
    entity?: ActorEntity;
    error?: string;
}
/** 设置角色；master 角色全局唯一（设新 master 时旧 master 自动降为 colleague） */
export declare function setRole(entityId: string, role: ActorRole): SetRoleResult;
/** 为既有实体追加渠道绑定（多渠道归一的正向路径） */
export declare function addBinding(entityId: string, channel: unknown, userId: unknown): SetRoleResult;
export interface MergeResult {
    ok: boolean;
    entity?: ActorEntity;
    error?: string;
}
/**
 * 实体归并：source 的全部绑定并入 target，source 标记 mergedInto（历史保留）。
 * 归并是「同一人多个渠道」的正向操作；被归并方后续解析自动跳转到 target。
 */
export declare function merge(sourceId: string, targetId: string): MergeResult;
export interface ActorListFilter {
    role?: ActorRole;
    channel?: string;
}
export declare function list(filter?: ActorListFilter): ActorEntity[];
export declare function stats(): {
    total: number;
    byRole: Record<ActorRole, number>;
    revision: number;
};
