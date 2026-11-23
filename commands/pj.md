---
name: pj
description: 破甲插件管理（拼音缩写命令）。用法：/pj [自检|面板|预设|应用|回滚|重载|探针|状态]
---

# /pj — kimi-purge 管理（拼音缩写命令，英文别名 /purge）

对 `$ARGUMENTS` 执行对应操作（缺省为 `zj` 自检）。脚本在本插件根的 `scripts/kimi-purge.mjs`；本文件位于 `<插件根>/commands/pj.md`，其上级目录即插件根。

用 Read/Bash 运行：`node <插件根>/scripts/kimi-purge.mjs <子命令>`（子命令支持拼音缩写、中文与英文原名，下表任一皆可）

| 拼音缩写 | 等价子命令 | 做什么 |
| --- | --- | --- |
| zj（默认） | `selfcheck` | 七层逐层汇报：① 注册 ② 注入 ③ 子代理 ④ 清单 ⑤ 引擎补丁 ⑥ 权限 ⑦ 探针；输出每层 ok/pending/warn/broken + 下一步动作 |
| mb | `report` | 生成 `~/.kimi-code/kimi-purge/report.html`（深色仪表盘：横幅 + 层卡片 + 环境表 + 审计图），路径打印在终端，自行在浏览器打开查看 |
| zt | `status` | 宿主路径、引擎状态、补丁计数、备份、宿主进程、版本预警 |
| ys / ys lb | `preset list` | 列出预设并标注生效项 |
| ys wx | `preset unrestricted` | 切无限制全类别契约（默认） |
| ys bz | `preset standard` | 切 1.1.x 常规破甲段 |
| yy | `apply` | 等长原位改写 app.asar 内 controller（先备份为 `app.asar.kimi-purge-orig`）；需 Kimi Code 已退出 |
| hg | `revert` | 用备份恢复 app.asar 并清理 meta/临时文件；需 Kimi Code 已退出 |
| cz | `reload` | KAP 热重载，免重启刷新注入段缓存（改注入文件后用，验证需新开会话） |
| tz | `probe` | 生成/回显 `~/.kimi-code/kimi-purge/probe.json` 的 nonce（30 分钟过期；`tz xj` 强制新建） |

中文对应：zj=自检 mb=面板 zt=状态 ys=预设 yy=应用 hg=回滚 cz=重载 tz=探针。

## 每轮状态码

本插件生效时，每次回复的最后一行会自动带：

```
⟦破甲 7/7 ✔⟧
```

看到它就表示注入链路 + 执行契约全部在线；看不到就说明注入段没加载（检查 managed 副本、reload、或新开会话）。

注意事项：应用/回滚直接改宿主 resources 目录，汇报时附上备份路径；任何一步失败立即停止并给错误原文。
