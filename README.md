# DSH Auto Debug

让 DSH 操作 Visual Studio，完成设置断点、启动程序、单步调试和调用栈采集。它是 **DSH 第三方插件**，不是 Visual Studio 扩展，不需要安装 VSIX。

## 运行要求

- Windows x64、Visual Studio 2022，以及目标项目所需的编译和调试组件。
- DSH 使用 Node.js 22 或更高版本。
- VS 2022 安装在 Program Files 标准目录；插件从该安装读取接口程序集，不随包分发 VS SDK。

插件包含 .NET 运行时，使用时不需要另装 .NET SDK。

## 安装

将固定版本包安装到 **DSH 使用的插件依赖目录**，不要装进要调试的业务工程：

```powershell
npm install --save-exact @feng0531/dsh-code-auto-debuger@0.1.1
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
3. 打开 DSH 侧栏的“自动调试”，点击“发现实例”，明确选择对应 VS、填写解决方案路径并连接。
4. 添加调试步骤，点击“预览计划”，核对目标、操作和时间预算后确认执行。
5. 在任务区查看进度和结果。切页、刷新或丢失响应后，用“从后台恢复会话任务”查询原任务，不要重复提交。

也可以直接在 DSH 对话中提出任务，例如：

> 使用 auto_debug 插件，只连接解决方案 G:\MyProject\MyProject.sln。在 src/main.cpp 第 42 行设置断点，启动程序，最多等待 20 秒暂停，然后采集调用栈。总预算 30 秒，不修改源码、不求值、不终止进程。先生成预览，等我确认。

插件提供 `auto_debug_*` 工具，供 DSH 的 Agent 完成发现、连接、预览、执行、查询和取消；不需要手动启动桥接程序。

## 能力与限制

- 支持断点、启动或附加、继续、暂停、单步、等待暂停和调用栈快照。每次执行都有步骤数和时间上限。
- **取消任务不等于暂停或终止程序**。断开连接也不会自动删除断点或停止目标。
- 不自动修改源码。快照不自动求值变量；显式表达式求值可能执行目标代码，求值和终止需要额外授权。
- 结果未知或保存失败时，先检查 VS 实际状态，再明确断开、重连和重新预览；插件不会自动重发调试操作。
- 已实测 VS 2022 C++ 的断点命中、源行推进、调用栈和自有断点删除。C#、全部扩展调试动作及真实 DSH GUI 安装尚未完整验收；不承诺远程调试或其他版本兼容。

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
- [0.1.1 修复与验收记录](docs/ACCEPTANCE-0.1.1.md)

## 许可证

本项目采用 [MIT License](LICENSE)，允许商业使用。第三方组件保留各自许可，见[第三方声明](THIRD_PARTY_NOTICES.md)。
