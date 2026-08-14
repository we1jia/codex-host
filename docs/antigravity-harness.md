# Antigravity Harness

CodexHost 通过 Antigravity CLI（`agy`）把 Antigravity 会话接入 Codex Desktop，而不是嵌入 Python SDK 或重做聊天界面。

## 前置条件

1. 按 [Antigravity 官方说明](https://antigravity.google/) 安装并登录 CLI。
2. 在终端执行 `agy --version`，确认命令可以运行。
3. 启动 `codexhost`，在新任务的 Agent 选择器中选择 **Antigravity**。

如果 `agy` 不在 `PATH` 中，可显式指定：

```bash
CODEXHOST_ANTIGRAVITY_COMMAND=/absolute/path/to/agy codexhost
```

## 工作方式

新会话调用：

```text
agy -p <prompt> --output-format stream-json
```

后续对话使用首次 `init` 事件确认的 `conversation_id`：

```text
agy -p <prompt> --conversation <conversation_id> --output-format stream-json
```

CodexHost 将文本增量、工具状态、子 Agent 状态、Usage 和最终结果投影到 Codex Desktop。`stderr` 只作为截断并脱敏的诊断信息，不会混入助手正文。取消操作会终止整个进程组；Windows 使用 `taskkill /t` 清理子进程树。

## 安全边界

- 不使用 `--dangerously-skip-permissions` 或同类跳过权限参数。
- 只有 CLI 返回的 `conversation_id` 才会被持久化为可恢复的原生会话引用。
- 未确认会话 ID、缺少最终 `result`、非零退出或格式错误的 JSON 都会失败关闭，不会伪报成功。
- 环境变量中的 Home 路径及常见 token、key、secret、password 值会在诊断信息中脱敏。

## MVP 能力

已支持流式文本、工具与子 Agent 状态、Usage、取消和会话恢复。当前不支持 Model/Thinking/权限模式选择、交互式审批与提问、Fork、回滚、上下文压缩和上一条消息修订。

Antigravity 自己决定模型，因此 CodexHost 的 Renderer 不显示外部模型选择器；内部只使用固定路由 `codexhost/antigravity-native`。

## 故障排查

- 显示未安装：确认 `agy --version` 可用，或设置 `CODEXHOST_ANTIGRAVITY_COMMAND`。
- 显示需要登录：在普通终端完成 Antigravity CLI 登录，再回到 CodexHost 重试。
- 草稿无法发送：路由尚未就绪时 CodexHost 会显示 `Agent route is not ready; your draft was kept.`，草稿不会被清空。
- 输入无法编辑：确认使用的是带 `data-codex-composer-root` 的 Codex 输入框；普通 Chat 输入框不由扩展接管。
