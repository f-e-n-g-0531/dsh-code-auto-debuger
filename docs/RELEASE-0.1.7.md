# 张良 / Zhang Liang 0.1.7

- 查询快照或状态时仍可手动接管。调查观察中断后，手动刷新可恢复持续更新；任务查询不完整时保留原请求和提示，不重发结果未知的操作。
- 切换 Visual Studio 连接前先读取新目标状态；读取失败保留旧连接。调试引擎不提供源位置时，仍可返回调用栈。
- 任务证据按变化刷新，历史列表复用已校验的摘要。
- 实机报告按次保存，新增候选包哈希核对和真实宿主首装清单。当前版本尚未在真实 DSH 与 Visual Studio 环境完成对话调试闭环验收。

[![](https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness)
