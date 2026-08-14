# Antigravity Harness 与 Composer 输入修复设计

## 1. 目标

在不修改官方 Codex Desktop 安装包的前提下，为 codexhost 增加 Antigravity 外部 Harness，并修复 Composer 事件拦截导致普通 Chat 或 Codex 输入框无法正常粘贴、剪切、删除和编辑的问题。

第一阶段以 macOS 实际闭环为验收平台，同时保持 TypeScript、Host Runtime 和 Adapter 代码的跨平台边界，不引入只在 macOS 可工作的 Harness 协议实现。

## 2. 已确认现状

- 发布版 `v0.1.6` 和当前 `main` 都会把 `Backspace`、`Delete`、普通字符、IME `Process`、`Cmd/Ctrl+V` 与 `Cmd/Ctrl+X` 识别为 Composer 输入意图。
- 当 Renderer 无法应用当前 Agent 路由或正处于切换状态时，捕获阶段监听器会调用 `preventDefault()` 和 `stopImmediatePropagation()`。
- 上游 PR #11 已验证普通 Chat Composer 可能被通用 form 兜底逻辑误识别，并通过只接受 `data-codex-composer-root` 修复该路径。
- PR #11 没有改变真实 Codex Composer 内部的 fail-closed 编辑逻辑，因此还需要第二层回归保护。
- Antigravity CLI 提供 `agy -p ... --output-format stream-json`、`conversation_id`、工具步骤、Subagent 信息和 Usage；Antigravity SDK 提供更完整的审批、流式输出、Subagent 和 Human-in-the-loop 能力。

## 3. 范围

### 3.1 第一阶段

1. 吸收并复核上游 PR #11 的 Chat/Codex Composer 隔离修复。
2. 普通编辑事件 fail-open：路由状态异常不得破坏文字输入、粘贴、剪切、删除、换行编辑或 IME。
3. 提交动作 fail-closed：只有发送消息时才要求 Agent 路由、外部配置和 Thread Ownership 全部就绪。
4. 新增 `antigravity` Harness 标识、Host Runtime 注册、Renderer Agent 选择项和图标。
5. 新增基于 `agy --output-format stream-json` 的 Antigravity Adapter。
6. 支持最小可用会话闭环：可用性检测、启动、流式文本、工具状态、Usage、继续会话、中断和明确错误。
7. 完成单元、协议、Renderer 和浏览器回归测试，并进行一次 macOS 本地验收。

### 3.2 后续独立阶段

- Python Antigravity SDK Bridge。
- 交互式审批和结构化用户提问。
- Subagent 管理界面。
- Artifacts 存储、审阅、评论、截图和浏览器录像。
- 跨工作区 Manager Surface。

这些能力不进入第一阶段，避免把一个可独立验收的 Harness 接入与完整 Agent 平台混成一次高风险改造。

### 3.3 非目标

- 不修改、重签名或重新分发官方 Codex Desktop。
- 不通过 UI 自动化驱动 Antigravity IDE。
- 不在第一阶段解析或复制 Antigravity TUI 的 Artifact 界面。
- 不伪造 Antigravity 不提供的审批、Diff、Thinking 或模型能力。
- 不在上游许可状态明确前发布安装包、npm 包或带二进制的 Release。

## 4. 方案比较

### 方案 A：Antigravity CLI Adapter，第一阶段采用

Node Host 直接启动 `agy` Headless 模式并解析 NDJSON。优点是依赖少、符合现有 Grok/Pi/Claude Adapter 模式、能快速形成真实闭环；缺点是 Headless 模式无法完成实时人工审批，部分能力只能按 CLI 实际事件投影。

### 方案 B：Python SDK Bridge，第二阶段采用

增加常驻 Python Bridge，通过 JSON-RPC/NDJSON 与 Node Host 通信。优点是能使用 Antigravity SDK 的审批、Subagent、生命周期 Hook 和多模态；缺点是引入 Python Runtime、Bridge 生命周期、版本兼容和打包成本。

### 方案 C：自动化 Antigravity IDE，不采用

通过 UI 自动化读取 Antigravity IDE 状态并回填 Codex。该方案没有稳定协议边界，难以正确处理会话、审批、取消和错误恢复，维护风险高于 codexhost 现有架构允许范围。

## 5. 总体架构

```text
Codex Desktop Renderer
  ├─ Agent Picker: Codex / Pi / Claude / DeepSeek / Grok / Antigravity
  └─ Composer events
       ├─ edit events -> always pass through
       └─ submit event -> validate and freeze route
                            |
codexhost CLI Shim -> Host Runtime / AppServerHost
                            |
                     HarnessAdapter map
                            |
                  AntigravityAdapter
                            |
             agy --output-format stream-json
```

各层职责保持现有仓库边界：

- `renderer-extension` 只负责 Agent 选择、Composer 识别和浏览器安全状态，不导入 Node 或 Antigravity SDK。
- `protocol-core` 只负责传输模型 ID、Codex UI 投影和通用路由。
- `host-runtime` 负责注册 Adapter、选择路由和管理外部 Thread。
- `adapters/antigravity` 独占 `agy` 命令、NDJSON 事件和 Antigravity 会话语义。
- `mapping-store` 只存 Codex Thread 与 Antigravity `conversation_id` 的映射，不理解 CLI 事件。

## 6. Composer 修复设计

### 6.1 识别边界

- Composer 只允许由官方 `[data-codex-composer-root]` 标记识别。
- 删除根据通用 `form`、可编辑元素和发送按钮向上猜测 Composer 的兜底逻辑。
- 标记被移除或元素断开时，立即卸载控件、清理计时器和绑定状态。
- 普通 Chat Composer 不挂载 Agent 控件，也不进入 codexhost 的输入、提交和点击处理。

### 6.2 编辑事件

下列事件不得因 Agent 切换、模型写入失败、Ownership 未就绪或外部配置异常被阻止：

- 普通字符和 IME 组合输入。
- `Backspace`、`Delete`。
- `Cmd/Ctrl+V`、`Cmd/Ctrl+X`、`Cmd/Ctrl+C`。
- `beforeinput` 中的插入、删除和粘贴类型。
- `Shift+Enter` 等不提交消息的编辑操作。

编辑过程中可以 best-effort 同步选择状态，但同步失败只能更新 Renderer 状态或诊断信息，不能调用 `preventDefault()`。

### 6.3 提交事件

提交按钮、表单 submit 和无 Shift 的 Enter 在以下任一条件不满足时继续 fail-closed：

- Composer 是受支持且仍挂载的 Codex Composer。
- Agent 切换已经结束。
- 外部 Harness 配置可用。
- 当前 Agent/Model/Permission 路由成功写入。
- 已有 Thread 的 Ownership 与当前 Composer 匹配。

提交被阻止时必须显示可理解的状态或错误，不能静默吞掉事件。草稿内容必须保留，用户修复配置后可以再次提交。

## 7. Antigravity Adapter 设计

### 7.1 注册与配置

- 新增 Harness ID：`antigravity`。
- 新增环境变量：`CODEXHOST_ANTIGRAVITY_COMMAND`，未设置时默认使用 `agy`。
- 启动前通过可执行文件解析和轻量版本探测判断可用性。
- 未安装或未认证时，Agent Picker 显示不可用原因，不影响官方 Codex 和其他 Harness。

### 7.2 进程调用

新会话：

```text
agy -p <prompt> --output-format stream-json
```

继续会话：

```text
agy -p <prompt> --conversation <conversation_id> --output-format stream-json
```

第一阶段不传 `--dangerously-skip-permissions`。命令继承项目 `cwd` 和用户已配置的 Antigravity 凭据、代理与权限规则。

### 7.3 事件映射

| Antigravity 事件 | codexhost 输出 |
| --- | --- |
| `event=init` 的顶层 `conversation_id` | Native Thread Reference |
| `step_update` + `agent_response.text_delta` | 流式 Agent 文本 |
| `step_update` + `tool` + `ACTIVE` | Tool started/update |
| `step_update` + `tool` + `DONE` | Tool completed/failed |
| `subagent_info` | 第一阶段作为具名 Tool/状态事件投影 |
| `result.status=SUCCESS` | Turn completed |
| `result.usage` | `HostUsage` |
| 非成功 `result` 或非零退出码 | Harness error |

只投影事件中真实存在的字段。未知 `step_type` 记录诊断并安全忽略；结构损坏、缺少终止事件或互相矛盾的终止状态必须返回明确错误。

### 7.4 会话与取消

- 首个有效 `conversation_id` 持久化为 Antigravity Native Thread ID。
- 后续 Turn 使用该 ID 继续，不用标题或 cwd 猜测会话。
- 取消时终止当前 `agy` 进程及其受监督子进程，最终只发送一次 interrupted/completed 终态。
- CLI 异常退出后保留已确认的 `conversation_id` 和已投影输出，允许用户重试，不生成虚假成功状态。

### 7.5 模型选择

第一阶段使用 Antigravity 用户配置的默认模型，不解析未稳定确认的 `agy models` 人类可读输出。模型目录和 reasoning effort 只有在获得稳定机器可读接口并添加契约测试后再开放。

## 8. 错误处理

必须区分以下错误，避免统一显示为“Agent unavailable”：

- `agy` 不存在或不可执行。
- Antigravity 尚未完成交互式认证。
- 当前权限策略软拒绝了工具。
- NDJSON 单行结构错误。
- CLI 非零退出。
- 会话 ID 无效或无法恢复。
- 用户主动取消。
- Renderer 路由未就绪导致提交被阻止。

stderr 作为诊断来源，不直接混入 Agent 正文。错误消息不得泄露凭据、环境变量值或完整敏感命令行。

## 9. 测试策略

### 9.1 Composer 回归

- 保留 PR #11 的普通 Chat 隔离 E2E，验证控件不挂载且 Backspace、粘贴和 `beforeinput` 不被阻止。
- 新增真实 Codex Composer 回归：让 `applyComposerAgent` 失败，验证普通字符、IME、Backspace、Delete、粘贴、剪切和 `beforeinput` 均未被阻止。
- 同一场景验证 Enter/submit 被阻止、草稿保留且错误状态可见。
- 验证从 Work 切换到 Chat 后旧绑定被销毁，再切回 Work 可以重新挂载。

### 9.2 Adapter 单元测试

使用受控假 `agy` Fixture，不访问真实 Google 服务，覆盖：

- 文本分片顺序。
- Tool ACTIVE/DONE 生命周期。
- Usage 累计和终态。
- 首次会话与 `--conversation` 恢复。
- stderr 与非零退出。
- 损坏 JSON、未知事件和缺少 `result`。
- 取消与子进程清理。

### 9.3 跨包测试

- `shared-contracts` 与 `protocol-core` 的 Harness ID、Transport Model ID 编解码。
- `host-runtime` Adapter 注册、可用性检查和路由。
- Renderer Agent Picker、图标、侧栏标识和恢复 Ownership。
- Release Bundle 包含 Antigravity Adapter，不导入 Python SDK。

### 9.4 macOS 验收

- 使用真实 Codex Desktop 验证 Chat 与 Work 输入框。
- 验证复制、粘贴、剪切、删除、中文 IME、Shift+Enter 和附件前后编辑。
- 使用已认证 `agy` 完成一次新 Thread 和一次继续会话。
- 验证流式文本、至少一个工具事件、Usage、取消和重启后继续。

真实 Antigravity 验收依赖用户本机已安装并完成认证；未满足时必须报告为外部前置条件未完成，不能用 Fixture 结果替代真实验收。

## 10. 完成标准

第一阶段只有同时满足以下条件才算完成：

1. Fork 中存在独立功能分支，远程上游仍指向 `BytePioneer-AI/codex-host`。
2. Chat Composer 完全不受 codexhost 控制。
3. Codex Composer 路由异常时仍可正常编辑，但不能错误提交到其他 Harness。
4. Agent Picker 可选择 Antigravity，缺失依赖时给出明确不可用状态。
5. Antigravity 新会话、流式输出、工具状态、Usage、继续会话和取消通过自动测试。
6. 相关 TypeScript 构建、聚焦单测、Renderer E2E 和 macOS 手工验收均有新鲜证据。
7. 文档明确第一阶段能力、限制、认证方式和未覆盖的 Manager/Artifacts 范围。

## 11. 许可与发布边界

上游 README 使用 MIT Badge，但截至本设计日期，仓库根目录没有 `LICENSE` 或 `COPYING` 文件。Fork 和内部开发可以继续，但在上游补齐许可证或提供明确授权前：

- 不发布安装包、npm 包或二进制 Release。
- 不宣称本 Fork 已获得 MIT 授权。
- README 保留上游来源和许可待确认说明。
- 若需要公开分发，先向上游确认并保存可追溯授权证据。
