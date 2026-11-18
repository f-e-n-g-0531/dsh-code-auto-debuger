# 张良 / Zhang Liang · DSH Auto Debug

让 DSH 当前会话的 AI Agent 结合源码和 Visual Studio 调试证据定位问题：你描述目标和范围，Agent 决定下一步该观察什么、在哪里下断点、是否继续或单步。插件是 **DSH 第三方插件**，不是 Visual Studio 扩展，不需要安装 VSIX；不自建模型后台，也不在后台自动读取源码。

## 运行要求

- Windows x64、Visual Studio 2022，以及目标项目所需的编译和调试组件。
- DSH 使用 Node.js 22 或更高版本。
- VS 2022 安装在 Program Files 标准目录；插件从该安装读取接口程序集，不随包分发 VS SDK。

插件包含 .NET 运行时，使用时不需要另装 .NET SDK。

## 安装

将固定版本包安装到 **DSH 使用的插件依赖目录**，不要装进要调试的业务工程：

```powershell
npm install --save-exact @feng0531/dsh-code-auto-debuger@0.1.8
```

也可以安装 [GitHub Releases](https://github.com/f-e-n-g-0531/dsh-code-auto-debuger/releases) 中的 `.tgz` 包。安装后，在 DSH 的 Cordis 插件列表中加入以下条目；保留原有配置，不要覆盖整个文件：

```yaml
- id: dsh-code-auto-debuger
  name: "@feng0531/dsh-code-auto-debuger"
  disabled: false
  config: {}
```

保存后，完全退出并重新启动 DSH。首次使用建议先在独立测试 DSH 中验证。

## 开始调试

1. 在 VS 打开解决方案，选择 Debug 配置并编译成功，设置正确的启动项目和参数。
2. 在 DSH 创建或选择会话，将工作目录设为工程根目录。解决方案和断点文件必须位于该目录内。
3. 在 DSH 对话中描述问题、复现方式、允许调试的解决方案和禁止事项，例如：

   > 帮我定位 G:\MyProject\MyProject.sln 中输入为空时崩溃的原因。先读相关代码，只调试这个工程。允许启动和单步，不修改源码、不求值、不附加其他进程、不终止程序；遇到超范围操作先问我。

4. Agent 读取相关代码，发现并明确选择 VS 实例，通过 `connect` 连接，再用 `begin` 确认本轮目标、权限和预算。你授权的是有边界的调试会话，不需要预先编排固定步骤。
5. Agent 每次通过 `perform` 提交一个原子操作，读取返回的状态、调用栈等证据后再决定下一步，最后给出定位依据、结论和未验证项。默认后台预算为 **64 次操作、10 分钟**；预算不是后台自主运行的模型。

“自动调试”面板用于观察证据、接管或取消，不是手写计划的主入口。刷新或丢失响应后先查询原任务，不能重复提交结果未知的操作。插件自动管理桥接程序，不需要手动启动。完整流程和授权示例见 [AI 辅助调试](docs/AI-DEBUGGING.md)。

## 能力与限制

- 支持断点、启动或附加、继续、暂停、单步、等待暂停和调用栈快照；后台按会话身份、目标、权限和预算限制操作。
- **取消或接管不等于暂停或终止程序**，也不回滚已发生的操作。断开连接不会自动删除断点或停止目标。
- 插件不自动修改源码。快照不自动求值变量；表达式可能执行目标代码，需要明确风险授权。附加必须授权固定 PID，终止程序必须另外授权。
- 结果未知（`unknown`）或保存失败时先查询原任务并检查 VS 实际状态，不得重发未知操作；恢复观察不代表恢复执行。
- [历史 C++ 实机验收](docs/ACCEPTANCE-0.1.1.md)覆盖断点命中、源行推进、调用栈和自有断点删除，不代表当前对话闭环或真实 DSH GUI 已验收。C# 和扩展调试动作也未完整验收；不承诺远程调试或其他版本兼容。

## 开发与验证

构建需要 Node.js 22 和 .NET 8 SDK：

```powershell
npm ci
npm run build:bridge
npm run check
npm run test:com
npm run verify:package
```

CI 仅由版本标签或手动触发，普通分支推送和 PR 不触发。完整测试、打包和发布步骤见[测试说明](docs/testing.md)和[发布说明](docs/releasing.md)。

- [架构](docs/architecture.md)
- [安全边界](docs/security.md)
- [CI 配置](docs/ci.md)

## 许可证

本项目采用 [MIT License](LICENSE)，允许商业使用。第三方组件保留各自许可，见[第三方声明](THIRD_PARTY_NOTICES.md)。
