# dsh-actors — 对话者注册表

数字分身的身份锚定插件（实施计划 T1）：多渠道身份归一到注册表实体，角色
（master / colleague / customer / stranger / blocked）由系统锚定，**对话者的
自我声明权重为零**——"我是老板"只会被当作普通文本。

## 机制

- **供给（provision）**：通道入口唯一路径。已绑定 → 返回实体；未绑定 → 新建
  stranger 实体（fail-closed：绝不推断身份）。
- **主人认领（bindMaster）**：全局唯一 master；重复认领幂等；第二人认领被拒。
- **归并（merge）**：同一人的多渠道身份合并，源实体标记 mergedInto（历史保留），
  解析自动跳转；master 身份随归并转移。
- **可见性对接**：实体 id 供 dsh-memory 的 participants 语义与 dsh-ledger 的
  actor 归因使用。

## 数据

`$DSH_HOME/dsh-actors/registry.json`（0600，临时文件 + 原子重命名，单 writer）。

## HTTP 管理路由（可选，webServer 注入）

`GET /dsh-actors/entities` · `POST /dsh-actors/provision` · `POST /dsh-actors/role`
（需主人渠道凭据）· `POST /dsh-actors/merge` · `POST /dsh-actors/bind`。
写端点 sameOrigin + JSON + 体积上限（插件自有路由不在上游认证围栏内）。

## 开发

```sh
npm test        # vitest 直跑 src（13 用例）
npm run build   # tsc → lib/
npm run typecheck
```

## 许可

MIT
