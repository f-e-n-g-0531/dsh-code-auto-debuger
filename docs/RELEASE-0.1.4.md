# DSH Auto Debug 0.1.4

## 变更

- 新增由当前 DSH 对话驱动的动态调试：`begin` 授权有边界调查，`perform` 每次执行一个原子动作并返回证据。
- 面板改为观察、接管和取消；不能发起调试或手写固定计划。接管和取消只停止后续自动化，不暂停、终止或回滚调试目标。
- 默认调查预算为 64 次操作、10 分钟。附加绑定开始时的固定 PID 与启动身份；求值和终止需要单独授权。
- 工作区变化会拒绝后续控制。结果未知时不重放；请求标识只保留已接受执行的操作，单个调查最多 1024 个。
- 协议门禁要求 version 0.1.4、protocol 1 和 dynamicDebug。旧 `preview` / `execute` 保留兼容。

## 安装或升级

在 DSH 插件依赖目录安装 `@feng0531/dsh-code-auto-debuger@0.1.4`，保留配置后由用户完全退出并重启 DSH。也可使用本 Release 的固定 tgz 包。使用方式见[README](../README.md)。

## 兼容与限制

Windows x64、标准目录安装的 VS 2022。历史 C++ 样例已验证断点命中、源行推进、调用栈和自有断点删除；这些记录不能证明 0.1.4 的对话闭环、接管或当前真实 DSH GUI 已通过实机验收。C# 和全部扩展调试动作仍未完整验收。

MIT License，允许商业使用。第三方组件保留各自许可。

[![](https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness)
