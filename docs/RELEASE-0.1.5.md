# DSH Auto Debug 0.1.5

## 变更

- 插件列表显示名改为 **张良 / Zhang Liang**。npm 包名和内部插件 ID 保持不变。
- 显示说明改为当前对话驱动的 Visual Studio 调试，不再把固定计划描述成主要用法。
- npm 公开核验窗口延长到约 30 分钟，避免版本已接收但传播未完成时误判失败。

## 安装或升级

在 DSH 插件依赖目录安装 `@feng0531/dsh-code-auto-debuger@0.1.5`，保留配置后由用户完全退出并重启 DSH。也可使用本 Release 的固定 tgz 包。使用方式见[README](../README.md)。

## 兼容与限制

Windows x64、标准目录安装的 VS 2022。显示名变更不改变调试协议。历史 C++ 样例不能证明对话闭环、接管或当前真实 DSH GUI 已通过实机验收。C# 和全部扩展调试动作仍未完整验收。

MIT License，允许商业使用。第三方组件保留各自许可。

[![](https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness)
