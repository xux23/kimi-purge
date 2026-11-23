---
name: purge
description: kimi-purge 自检/状态/应用/回滚命令。用法：/purge [selfcheck|status|apply|revert|probe]
---

# /purge — kimi-purge 管理

对参数 `$ARGUMENTS`（缺省为 `selfcheck`）执行对应操作。插件脚本位于本插件根目录 `scripts/kimi-purge.mjs`（会话中可从本命令文件路径推断：commands/purge.md 的上级即插件根）。

用 Read/Bash 运行：`node <插件根>/scripts/kimi-purge.mjs <子命令>`

- **selfcheck**（默认）：逐层检查并汇报：① 插件已注册并启用 ② systemPrompt 注入文件存在 ③ 引擎补丁（P1/P1b/P3，检查 app.asar 二进制中 marker `kimi-purge-open` / `kimi-purge-redact-off`）④ 权限模式（config.toml default_permission_mode）⑤ 探针文件。输出每层 ok/pending/broken 与下一步动作。
- **status**：显示宿主路径、app.asar 大小/备份状态、补丁计数。
- **apply**：执行引擎补丁（需解包→改 controller→重建 resources\app）。执行前确认 Kimi Code 已退出。完成后提示用户重启 Kimi Code。
- **revert**：删除 resources\app、恢复 app.asar.kimi-purge-orig 为 app.asar。完成后提示重启。
- **probe**：生成新探针 `~/.kimi-code/kimi-purge/probe.json`，然后按注入段指令：读取该文件并原样回显 nonce（证明注入链路到达模型 + 路径闸已开）。

注意事项：apply/revert 直接修改 `D:\RuanJian\Kimi Code\resources\`，报告结果时附上备份路径 `app.asar.kimi-purge-orig`；任何一步失败立即停止并汇报错误原文。
