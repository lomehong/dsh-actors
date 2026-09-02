/**
 * dsh-actors — 对话者注册表插件（实施计划 T1）
 *
 * 核心在 ./registry.ts；本文件只做宿主胶水：
 * - provide('dsh-actors') 服务（供 im-channel / dsh-memory / dsh-ledger 消费）
 * - 可选注入 webServer：管理路由（列表 / 设角色 / 归并 / 主人认领）
 *
 * 纪律（沿用 LESSONS #2）：apply() 全路径防御，任何异常不得击穿宿主启动。
 * 写端点 sameOrigin + JSON content-type + 体积上限（插件自有路由不在上游认证围栏内）。
 */
import { ACTOR_ROLES, addBinding, bindMaster, list, merge, provision, resolve, setRole, stats, normalizeChannel, normalizeUserId, } from "./registry.js";
export const name = 'dsh-actors';
export const provide = ['dsh-actors'];
const BODY_LIMIT = 64 * 1024;
function readJsonBody(req) {
    return new Promise((resolve, reject) => {
        const ct = String(req.headers['content-type'] ?? '');
        if (!/application\/json/i.test(ct)) {
            reject(new Error('content-type must be application/json'));
            req.resume();
            return;
        }
        const chunks = [];
        let size = 0;
        req.on('data', c => {
            size += c.length;
            if (size > BODY_LIMIT) {
                reject(new Error('request body too large'));
                req.destroy();
                return;
            }
            chunks.push(c);
        });
        req.on('end', () => {
            try {
                const all = Buffer.concat(chunks).toString('utf8');
                resolve(all ? JSON.parse(all) : {});
            }
            catch (e) {
                reject(e);
            }
        });
        req.on('error', reject);
    });
}
function sameOrigin(req) {
    const origin = req.headers.origin;
    if (origin === undefined)
        return true;
    const host = req.headers.host;
    if (typeof host !== 'string' || host === '')
        return false;
    try {
        return new URL(String(origin)).host === host;
    }
    catch {
        return false;
    }
}
function respondJson(res, status, data) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify(data));
}
export function apply(ctx) {
    const c = ctx;
    try {
        c.logger?.info?.('[dsh-actors] 对话者注册表已加载');
    }
    catch {
        // 日志失败忽略
    }
    const service = {
        provision,
        resolve,
        bindMaster,
        setRole,
        addBinding,
        merge,
        list,
        stats,
        normalizeChannel,
        normalizeUserId,
        roles: ACTOR_ROLES,
    };
    try {
        c.provide?.('dsh-actors', service);
    }
    catch (e) {
        c.logger?.warn?.('[dsh-actors] provide 失败:', e instanceof Error ? e.message : String(e));
    }
    // 管理路由是可选能力：没有 webServer 也照常工作
    try {
        c.inject?.(['webServer'], (wctx) => {
            const web = wctx.get?.('webServer');
            if (web === undefined || typeof web.register !== 'function')
                return;
            const disposers = [];
            disposers.push(web.register({
                kind: 'exact',
                path: '/dsh-actors/entities',
                handler: (_req, res) => {
                    respondJson(res, 200, { ok: true, entities: list(), stats: stats() });
                },
            }));
            // v2 关系档案聚合：实体 + 关系轨（观察/推断/开环）——软依赖 dsh-memory
            disposers.push(web.register({
                kind: 'exact',
                path: '/dsh-actors/profiles',
                handler: (_req, res) => {
                    try {
                        const memory = c.get?.('dsh-memory');
                        const relEntries = memory?.loadSharedMemory?.() ?? [];
                        const profiles = list().map(entity => {
                            const rels = relEntries.filter(x => x.relation?.actorId === entity.id && (x.lifecycle?.state ?? '当前') === '当前');
                            const openLoops = rels.filter(x => x.relation?.openLoop !== undefined && x.relation.openLoop.closedAt === undefined);
                            return {
                                entity,
                                relationCount: rels.length,
                                openLoops: openLoops.map(x => ({
                                    memoryId: x.id,
                                    content: x.content,
                                    openedAt: x.relation?.openLoop?.openedAt ?? x.timestamp ?? '',
                                })),
                                observations: rels
                                    .filter(x => x.relation?.openLoop === undefined || x.relation.openLoop.closedAt !== undefined)
                                    .slice(-5)
                                    .map(x => ({ memoryId: x.id, kind: x.relation?.kind ?? '观察', content: x.content, ts: x.timestamp ?? '' })),
                            };
                        });
                        respondJson(res, 200, { ok: true, profiles });
                    }
                    catch (e) {
                        respondJson(res, 500, { ok: false, error: e instanceof Error ? e.message : String(e) });
                    }
                },
            }));
            disposers.push(web.register({
                kind: 'exact',
                path: '/dsh-actors/provision',
                handler: async (req, res) => {
                    if (req.method !== 'POST' || !sameOrigin(req)) {
                        respondJson(res, req.method === 'POST' ? 403 : 405, { ok: false, error: 'denied' });
                        return;
                    }
                    try {
                        const body = (await readJsonBody(req));
                        const r = provision(body.channel, body.userId, body.displayName);
                        respondJson(res, 200, { ok: true, ...r });
                    }
                    catch (e) {
                        respondJson(res, 400, { ok: false, error: e instanceof Error ? e.message : String(e) });
                    }
                },
            }));
            disposers.push(web.register({
                kind: 'exact',
                path: '/dsh-actors/role',
                handler: async (req, res) => {
                    if (req.method !== 'POST' || !sameOrigin(req)) {
                        respondJson(res, req.method === 'POST' ? 403 : 405, { ok: false, error: 'denied' });
                        return;
                    }
                    try {
                        const body = (await readJsonBody(req));
                        // 写端点要求主人凭据（渠道身份须已认领 master），凭据不足一律拒绝
                        if (typeof body.masterChannel !== 'string' || typeof body.masterUserId !== 'string') {
                            respondJson(res, 403, { ok: false, error: '需要主人渠道凭据' });
                            return;
                        }
                        const master = resolve(body.masterChannel, body.masterUserId);
                        if (master === null || master.role !== 'master') {
                            respondJson(res, 403, { ok: false, error: '仅主人可变更角色' });
                            return;
                        }
                        const r = setRole(String(body.entityId), body.role);
                        respondJson(res, r.ok ? 200 : 400, r);
                    }
                    catch (e) {
                        respondJson(res, 400, { ok: false, error: e instanceof Error ? e.message : String(e) });
                    }
                },
            }));
            disposers.push(web.register({
                kind: 'exact',
                path: '/dsh-actors/merge',
                handler: async (req, res) => {
                    if (req.method !== 'POST' || !sameOrigin(req)) {
                        respondJson(res, req.method === 'POST' ? 403 : 405, { ok: false, error: 'denied' });
                        return;
                    }
                    try {
                        const body = (await readJsonBody(req));
                        const r = merge(String(body.sourceId), String(body.targetId));
                        respondJson(res, r.ok ? 200 : 400, r);
                    }
                    catch (e) {
                        respondJson(res, 400, { ok: false, error: e instanceof Error ? e.message : String(e) });
                    }
                },
            }));
            disposers.push(web.register({
                kind: 'exact',
                path: '/dsh-actors/bind',
                handler: async (req, res) => {
                    if (req.method !== 'POST' || !sameOrigin(req)) {
                        respondJson(res, req.method === 'POST' ? 403 : 405, { ok: false, error: 'denied' });
                        return;
                    }
                    try {
                        const body = (await readJsonBody(req));
                        const r = addBinding(String(body.entityId), body.channel, body.userId);
                        respondJson(res, r.ok ? 200 : 400, r);
                    }
                    catch (e) {
                        respondJson(res, 400, { ok: false, error: e instanceof Error ? e.message : String(e) });
                    }
                },
            }));
            if (typeof web.effect === 'function') {
                web.effect(() => () => {
                    for (const d of disposers)
                        d();
                });
            }
            c.logger?.info?.('[dsh-actors] 管理路由已注册 (/dsh-actors/*)');
        });
    }
    catch (e) {
        c.logger?.warn?.('[dsh-actors] webServer 注入失败（不影响核心服务）:', e instanceof Error ? e.message : String(e));
    }
}
export { provision, resolve, bindMaster, setRole, addBinding, merge, list, stats, normalizeChannel, normalizeUserId } from "./registry.js";
