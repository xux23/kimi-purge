---
name: purge
description: kimi-purge 自检/状态/预设/应用/回滚/热重载命令。用法：/purge [selfcheck|status|preset [list|standard|unrestricted]|apply|revert|reload|probe]
---

# /purge — kimi-purge 管理

对参数 `$ARGUMENTS`（缺省为 `selfcheck`）执行对应操作。插件脚本位于本插件根目录 `scripts/kimi-purge.mjs`（会话中可从本命令文件路径推断：commands/purge.md 的上级即插件根）。

用 Read/Bash 运行：`node <插件根>/scripts/kimi-purge.mjs <子命令>`

- **selfcheck**（默认）：逐层检查并汇报：① 插件已注册并启用 ② systemPrompt 注入文件存在 ③ unrestricted 子代理（agents/unrestricted.md，override:true）④ 清单层（hooks/agents/skills/commands 计数）⑤ 引擎补丁（P1–P9，检查 app.asar 二进制中三个 marker）⑥ 权限模式（config.toml default_permission_mode）⑦ 探针文件。输出每层 ok/pending/warn/broken 与下一步动作；宿主版本 ≠ 备份版本时输出 warn。
- **status**：显示宿主路径、引擎状态、补丁计数、备份、宿主进程、版本预警。
- **preset**：预设切换。`preset list` 列出 `presets/*.md` 并标注生效项；`preset unrestricted`（无限制全类别契约，默认）或 `preset standard`（1.1.x 常规破甲段）复制到 purge-inject.md，自动 install 同步 managed 副本，宿主在跑时自动热重载。
- **apply**：等长原位改写 app.asar 内 controller（原文件改名备份 app.asar.kimi-purge-orig）。执行前确认 Kimi Code 已退出（运行中会拒绝）。完成后提示用户重启 Kimi Code。
- **revert**：恢复备份为 app.asar 并清理 meta/临时文件。执行前确认 Kimi Code 已退出。完成后提示重启。
- **reload**：KAP 热重载，免重启刷新插件 systemPrompt 缓存（改 purge-inject.md 后用；验证需新开会话）。
- **probe**：生成新探针 `~/.kimi-code/kimi-purge/probe.json`（30 分钟过期，过期自动重新生成），然后按注入段指令：读取该文件并原样回显 nonce（证明注入链路到达模型 + 路径闸已开）。

注意事项：apply/revert 直接修改宿主 resources 目录，报告结果时附上备份路径；任何一步失败立即停止并汇报错误原文。
