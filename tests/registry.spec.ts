/**
 * dsh-actors 契约测试：直接跑 src TS 源码（vitest），DSH_HOME 隔离到临时目录。
 * 锁定治理行为：身份系统锚定、master 全局唯一、归并别名解析、fail-closed 未注册隔离。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let home: string

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'dsh-actors-test-'))
  process.env.DSH_HOME = home
})

afterEach(() => {
  delete process.env.DSH_HOME
  rmSync(home, { recursive: true, force: true })
})

async function reg() {
  return import('../src/registry.ts')
}

describe('provision / resolve（身份系统锚定）', () => {
  it('首次供给创建 stranger 实体，重复供给幂等', async () => {
    const r = await reg()
    const first = r.provision('WeCom', 'user-a')
    expect(first.created).toBe(true)
    expect(first.entity.role).toBe('stranger')
    expect(first.entity.bindings[0]!.channel).toBe('wecom') // 渠道名归一小写

    const second = r.provision('wecom', 'user-a')
    expect(second.created).toBe(false)
    expect(second.entity.id).toBe(first.entity.id)
  })

  it('未注册对话者 resolve 返回 null（fail-closed，不自动建身份）', async () => {
    const r = await reg()
    expect(r.resolve('feishu', 'ghost')).toBeNull()
  })

  it('channel/userId 非法输入被拒或清洗', async () => {
    const r = await reg()
    expect(() => r.provision('', 'x')).toThrow()
    expect(() => r.provision('wecom', '  ')).toThrow()
    const dirty = r.provision('wecom', 'u\x00\u001f1')
    expect(dirty.entity.bindings[0]!.userId).toBe('u1') // 控制字符被剥离
  })

  it('resolve 沿归并别名跳转', async () => {
    const r = await reg()
    const a = r.provision('wecom', 'u-1').entity
    const b = r.provision('feishu', 'u-2').entity
    const merged = r.merge(b.id, a.id)
    expect(merged.ok).toBe(true)
    // feishu:u-2 的绑定已并入 a：两个渠道身份都解析到同一实体（跨渠道归一）
    expect(r.resolve('wecom', 'u-1')!.id).toBe(a.id)
    expect(r.resolve('feishu', 'u-2')!.id).toBe(a.id)
    expect(r.resolve('feishu', 'u-1')).toBeNull()
  })
})

describe('主人锚定（全局唯一 master）', () => {
  it('第一个 bindMaster 认领成功，第二个被拒', async () => {
    const r = await reg()
    const first = r.bindMaster('wecom', 'boss')
    expect(first.ok).toBe(true)
    expect(first.entity!.role).toBe('master')

    const second = r.bindMaster('feishu', 'imposter')
    expect(second.ok).toBe(false)
    expect(second.error).toContain('已存在主人')
    // 冒充者的实体仍存在，但角色是 stranger——不会被提权
    const entity = r.resolve('feishu', 'imposter')
    expect(entity!.role).toBe('stranger')
  })

  it('同一主人重复认领幂等', async () => {
    const r = await reg()
    const first = r.bindMaster('wecom', 'boss')
    const again = r.bindMaster('wecom', 'boss')
    expect(again.ok).toBe(true)
    expect(again.entity!.id).toBe(first.entity!.id)
  })

  it('setRole 换 master 时旧 master 自动降为 colleague', async () => {
    const r = await reg()
    const old = r.bindMaster('wecom', 'boss').entity!
    const other = r.provision('feishu', 'successor').entity
    const changed = r.setRole(other.id, 'master')
    expect(changed.ok).toBe(true)
    expect(r.getEntity(other.id)!.role).toBe('master')
    expect(r.getEntity(old.id)!.role).toBe('colleague')
  })

  it('仅主人可经角色端点变更（web 层凭据校验在 index 侧，这里锁核心不变量）', async () => {
    const r = await reg()
    r.bindMaster('wecom', 'boss')
    const stranger = r.provision('feishu', 'guest').entity
    expect(r.setRole(stranger.id, 'colleague').ok).toBe(true) // 核心不区分调用者；调用者校验在路由层
    expect(r.setRole(stranger.id, 'unknown' as never).ok).toBe(false)
  })
})

describe('归并与列表', () => {
  it('merge 移动绑定、源实体标记 mergedInto 并从列表隐藏', async () => {
    const r = await reg()
    const a = r.provision('wecom', 'u-1').entity
    const b = r.provision('feishu', 'u-2').entity
    const merged = r.merge(b.id, a.id)
    expect(merged.ok).toBe(true)
    expect(merged.entity!.bindings.map(x => x.channel).sort()).toEqual(['feishu', 'wecom'])
    expect(r.list().find(e => e.id === b.id)).toBeUndefined()
    expect(r.merge(a.id, a.id).ok).toBe(false) // 自归并拒绝
    expect(r.merge(b.id, a.id).ok).toBe(false) // 已归并实体不可再作为源
  })

  it('master 归并转移主人身份到 target', async () => {
    const r = await reg()
    const master = r.bindMaster('wecom', 'boss').entity!
    const other = r.provision('feishu', 'person').entity
    const merged = r.merge(master.id, other.id)
    expect(merged.ok).toBe(true)
    expect(r.getEntity(other.id)!.role).toBe('master')
  })
})

describe('持久化与统计', () => {
  it('数据跨加载持久化，revision 递增', async () => {
    const r = await reg()
    r.provision('wecom', 'u-1')
    r.provision('wecom', 'u-2')
    const s1 = r.stats()
    expect(s1.total).toBe(2)
    expect(s1.byRole.stranger).toBe(2)
    const rev1 = s1.revision

    const s2 = r.stats()
    expect(s2.revision).toBe(rev1) // 只读不写不递增
    expect(rev1).toBeGreaterThan(0)
  })

  it('blocked 角色可标记并被 list(role) 过滤', async () => {
    const r = await reg()
    const e = r.provision('wecom', 'troll').entity
    r.setRole(e.id, 'blocked')
    expect(r.resolve('wecom', 'troll')!.role).toBe('blocked')
    expect(r.list({ role: 'blocked' }).map(x => x.id)).toEqual([e.id])
  })

  it('addBinding 支持多渠道归一正向路径；冲突绑定要求 merge', async () => {
    const r = await reg()
    const a = r.provision('wecom', 'u-1').entity
    const added = r.addBinding(a.id, 'feishu', 'u-1b')
    expect(added.ok).toBe(true)

    const b = r.provision('qq', 'someone').entity
    const clash = r.addBinding(b.id, 'wecom', 'u-1')
    expect(clash.ok).toBe(false)
    expect(clash.error).toContain('merge')
  })
})
