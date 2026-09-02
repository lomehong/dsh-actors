/**
 * 对话者注册表核心（实施计划 T1）
 *
 * 职责：多渠道身份归一（同一人多个渠道绑定到同一实体）、角色锚定
 * （master / colleague / customer / stranger / blocked）、fail-closed
 * 未注册隔离（未注册对话者一律按「生人」处理，绝不采信自我声明）。
 *
 * 身份由系统锚定（渠道强认证 + 本注册表），对话者的自我声明在本模块
 * 权重为零——「我是老板」只会被当作普通文本，不改变任何角色。
 *
 * 存储：$DSH_HOME/dsh-actors/registry.json（0600，临时文件 + 原子重命名，
 * 单 writer 假设与 dsh-twin 相同——注册表是低频配置型数据）。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
export const ACTOR_ROLES = ['master', 'colleague', 'customer', 'stranger', 'blocked'];
export function actorHome() {
    return process.env.DSH_HOME ?? join(homedir(), '.dsh');
}
function registryPath() {
    return join(actorHome(), 'dsh-actors', 'registry.json');
}
/** 渠道名归一：小写、去空白；userId 清除控制字符并限长 */
export function normalizeChannel(channel) {
    return String(channel ?? '').trim().toLowerCase().slice(0, 40);
}
export function normalizeUserId(userId) {
    return String(userId ?? '')
        .replace(/[\u0000-\u001F\u007F]/g, '')
        .trim()
        .slice(0, 120);
}
function sanitizeText(input, max) {
    if (typeof input !== 'string')
        return '';
    return input
        .normalize('NFC')
        .replace(/[\u0000-\u001F\u007F]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, max);
}
function generateId() {
    return `act_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}
/** 加载注册表；文件缺失/损坏时返回空表（损坏文件留 .corrupt-* 备份可人工恢复） */
export function loadRegistry() {
    const path = registryPath();
    if (!existsSync(path))
        return { revision: 0, entities: [] };
    try {
        const store = JSON.parse(readFileSync(path, 'utf8'));
        if (!Array.isArray(store.entities))
            return { revision: 0, entities: [] };
        return { revision: Number(store.revision) || 0, entities: store.entities };
    }
    catch {
        try {
            renameSync(path, `${path}.corrupt-${Date.now()}`);
        }
        catch {
            // 备份失败只能返回空
        }
        return { revision: 0, entities: [] };
    }
}
/** 原子保存（临时文件 + rename，0600） */
export function saveRegistry(store) {
    const path = registryPath();
    mkdirSync(dirname(path), { recursive: true });
    store.revision = (Number(store.revision) || 0) + 1;
    const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
    writeFileSync(tmp, `${JSON.stringify(store, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    renameSync(tmp, path);
}
/** 沿 mergedInto 链解析到存活实体（带环保护，链长上限 8） */
export function resolveAlias(store, entity) {
    let current = entity;
    for (let hop = 0; hop < 8; hop++) {
        if (current.mergedInto === undefined)
            return current;
        const next = store.entities.find(e => e.id === current.mergedInto);
        if (next === undefined)
            return current; // 目标丢失：停在原地，fail-closed
        current = next;
    }
    return current;
}
/** 按渠道身份精确查找绑定（含被归并实体的别名绑定） */
export function findByChannelIdentity(store, channel, userId) {
    const ch = normalizeChannel(channel);
    const uid = normalizeUserId(userId);
    if (ch === '' || uid === '')
        return undefined;
    const hit = store.entities.find(e => e.mergedInto === undefined &&
        e.bindings.some(b => b.channel === ch && b.userId === uid));
    return hit;
}
/**
 * 解析或供给：已绑定 → 返回实体；未绑定 → 新建 stranger 实体并绑定。
 * 这是通道入口的唯一路径——身份永远由本注册表锚定，不接受对话者自述。
 */
export function provision(channel, userId, displayName) {
    const ch = normalizeChannel(channel);
    const uid = normalizeUserId(userId);
    if (ch === '' || uid === '') {
        throw new Error('actor provision: channel/userId 不能为空');
    }
    const store = loadRegistry();
    const existing = findByChannelIdentity(store, ch, uid);
    if (existing !== undefined)
        return { entity: resolveAlias(store, existing), created: false };
    const entity = {
        id: generateId(),
        createdAt: new Date().toISOString(),
        role: 'stranger',
        bindings: [{ channel: ch, userId: uid, boundAt: new Date().toISOString() }],
        ...(sanitizeText(displayName, 60) !== '' ? { displayName: sanitizeText(displayName, 60) } : {}),
    };
    store.entities.push(entity);
    saveRegistry(store);
    return { entity, created: true };
}
/** 解析（不新建）；未注册返回 null——调用方按 fail-closed 处理 */
export function resolve(channel, userId) {
    const store = loadRegistry();
    const hit = findByChannelIdentity(store, normalizeChannel(channel), normalizeUserId(userId));
    return hit === undefined ? null : resolveAlias(store, hit);
}
export function getEntity(entityId) {
    const store = loadRegistry();
    const hit = store.entities.find(e => e.id === entityId && e.mergedInto === undefined);
    return hit ?? null;
}
/**
 * 主人认领：全局唯一 master。已存在其他 master 时拒绝（需先显式让位），
 * 同一实体重复认领幂等成功。认领同时建立渠道绑定。
 */
export function bindMaster(channel, userId) {
    const provisioned = provision(channel, userId);
    const store = loadRegistry();
    const entity = resolveAlias(store, findByChannelIdentity(store, normalizeChannel(channel), normalizeUserId(userId)));
    void provisioned;
    const currentMaster = store.entities.find(e => e.mergedInto === undefined && e.role === 'master');
    if (currentMaster !== undefined && currentMaster.id !== entity.id) {
        return { ok: false, error: `已存在主人（${currentMaster.id}）；更换主人需先显式让位` };
    }
    if (entity.role !== 'master') {
        entity.role = 'master';
        saveRegistry(store);
    }
    return { ok: true, entity };
}
/** 设置角色；master 角色全局唯一（设新 master 时旧 master 自动降为 colleague） */
export function setRole(entityId, role) {
    if (!ACTOR_ROLES.includes(role))
        return { ok: false, error: `未知角色：${String(role)}` };
    const store = loadRegistry();
    const entity = store.entities.find(e => e.id === entityId && e.mergedInto === undefined);
    if (entity === undefined)
        return { ok: false, error: '实体不存在' };
    if (role === 'master') {
        const currentMaster = store.entities.find(e => e.mergedInto === undefined && e.role === 'master' && e.id !== entityId);
        if (currentMaster !== undefined)
            currentMaster.role = 'colleague';
    }
    entity.role = role;
    saveRegistry(store);
    return { ok: true, entity };
}
/** 为既有实体追加渠道绑定（多渠道归一的正向路径） */
export function addBinding(entityId, channel, userId) {
    const ch = normalizeChannel(channel);
    const uid = normalizeUserId(userId);
    if (ch === '' || uid === '')
        return { ok: false, error: 'channel/userId 不能为空' };
    const store = loadRegistry();
    const entity = store.entities.find(e => e.id === entityId && e.mergedInto === undefined);
    if (entity === undefined)
        return { ok: false, error: '实体不存在' };
    const clash = findByChannelIdentity(store, ch, uid);
    if (clash !== undefined && clash.id !== entityId) {
        return { ok: false, error: `该渠道身份已绑定到 ${clash.id}；请用 merge 合并实体` };
    }
    if (!entity.bindings.some(b => b.channel === ch && b.userId === uid)) {
        entity.bindings.push({ channel: ch, userId: uid, boundAt: new Date().toISOString() });
        saveRegistry(store);
    }
    return { ok: true, entity };
}
/**
 * 实体归并：source 的全部绑定并入 target，source 标记 mergedInto（历史保留）。
 * 归并是「同一人多个渠道」的正向操作；被归并方后续解析自动跳转到 target。
 */
export function merge(sourceId, targetId) {
    if (sourceId === targetId)
        return { ok: false, error: '不能归并到自身' };
    const store = loadRegistry();
    const source = store.entities.find(e => e.id === sourceId && e.mergedInto === undefined);
    const target = store.entities.find(e => e.id === targetId && e.mergedInto === undefined);
    if (source === undefined || target === undefined)
        return { ok: false, error: '实体不存在' };
    if (source.role === 'master' && target.role !== 'master') {
        // 主人身份随归并转移到 target（显式操作才可能走到这里）
        target.role = 'master';
    }
    for (const b of source.bindings) {
        if (!target.bindings.some(x => x.channel === b.channel && x.userId === b.userId)) {
            target.bindings.push(b);
        }
    }
    if (target.displayName === undefined && source.displayName !== undefined) {
        target.displayName = source.displayName;
    }
    source.mergedInto = targetId;
    source.bindings = [];
    saveRegistry(store);
    return { ok: true, entity: target };
}
export function list(filter = {}) {
    const store = loadRegistry();
    return store.entities
        .filter(e => e.mergedInto === undefined)
        .filter(e => (filter.role !== undefined ? e.role === filter.role : true))
        .filter(e => {
        if (filter.channel === undefined)
            return true;
        const ch = normalizeChannel(filter.channel);
        return e.bindings.some(b => b.channel === ch);
    });
}
export function stats() {
    const store = loadRegistry();
    const byRole = { master: 0, colleague: 0, customer: 0, stranger: 0, blocked: 0 };
    for (const e of store.entities) {
        if (e.mergedInto !== undefined)
            continue;
        byRole[e.role] = (byRole[e.role] ?? 0) + 1;
    }
    return { total: store.entities.filter(e => e.mergedInto === undefined).length, byRole, revision: store.revision };
}
