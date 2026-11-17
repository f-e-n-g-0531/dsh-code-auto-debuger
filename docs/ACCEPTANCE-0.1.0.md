# 0.1.0 本地候选验收记录

> 历史验收记录：许可、提交和发布状态为验收当时情况；当前许可见仓库 LICENSE，发布状态见 GitHub Releases 与 npm 注册表。

日期：2026-11-14（Asia/Shanghai）。状态：首版功能实现与本地候选验证；不是正式发布或生产安装批准。

## 环境

Windows x64；隔离 Node.js 22.23.5、.NET SDK 8.0.428；Visual Studio Community 2022 17.14.45。未全局升级 SDK、未安装 VSIX、未更改日常 DSH 配置。

## 已核对

- TypeScript 类型检查、Node 前后端构建。
- 核心预览/确认、单次消费、会话和实例互斥、连接竞争/卸载、取消、未知副作用、工作区路径与存储、附加PID启动身份、预览不可篡改。
- DSH ModuleLoader VM 注册与 RPC 契约；真实 ToolsService registry 10 工具注册使用参考仓库 SDK 0.2.2-rc.1。它不是当前安装 rc.3 / GUI 的完整兼容验收。
- 方案 A：仅 v* 标签与手动触发；无普通分支/PR/定时触发；只生成候选，不发布。
- 桥接 .NET8 构建 0 warnings / 0 errors；7 条断连协议输入边界记录通过。

## 真实 Visual Studio C++ 证据

独立样例 VS PID22968，启动2026-11-14T10:45:18.1077739Z，debuggee23584：精确发现/连接design、创建自有断点、启动并观察break、快照3线程8栈帧（顶部Add/main）、未求值变量、step-over返回后再次观察break和快照、自有断点移除通过。相关实测说明见[桥接记录](https://github.com/f-e-n-g-0531/dsh-code-auto-debuger/blob/v0.1.1/bridge/README.md)。全部测试创建进程已清理，未控制已有工作实例。

### 明确限制

- 快照源位置为null；step返回和break不证明精确源行前进。
- 扩展continue测试返回但仍在break，等待超时；原因未确认，可能有此前样例保留断点。不得把continue/pause/attach/detach/terminate/evaluate列为完整实机通过。
- C#样例可编译，但VS载入遇到“评审项目和解决方案更改/不支持项目”模态框；未点击接受、未安装工作负载，因此C#调试未验收。
- 不隐式求值变量，显式求值需要风险授权。异步launch若当时未捕获debuggee，后续detach/terminate保守拒绝；不得放宽身份门禁。
- DSH真实GUI安装与页面操作未执行；前端仅完成构建和ModuleLoader契约测试。
- GitHub Actions未远程触发；本地检查不是远程CI运行凭据。

## 交付

候选包和SHA256 manifest由打包脚本生成到.artifacts。候选归档不包含调试快照、样例构建、SDK或node_modules。尚未选择公开分发许可（UNLICENSED）；没有commit、push、tag、npm发布、正式Release或工作DSH安装。

## 主服务真实闭环补验

Node22 主服务使用全新 C++ build-service 解决方案，VS PID24696 / debuggee9204：预览→单次确认执行→创建断点→启动→等待break→快照成功，4/4步骤，3线程8栈帧，variablesEvaluated=false，position=null。原始证据保存在本地.artifacts/service-smoke.json，不随候选包分发。

前几次实测明确失败并保留了unknown：重复/不可创建断点时Add返回0，以及launch返回后读取状态遇BUSY。最终修复只读status有限重试，launch后的忙碌进程采集不授予破坏性权限；没有自动重放任何调试变更。新样例就绪后在另一有效行设置断点完成闭环。测试仅清理精确PID+启动时间且名为DshDebugFixture的样例进程，并关闭本次创建的VS。

## 最终本地检查

Node22执行 npm run check：27/27通过、0跳过；随后自包含桥接publish、test:bridge、verify:package全部退出0。CI策略静态验证通过；7条协议边界记录通过。候选归档与隔离安装结果单独保存在本地交付清单，不能当成真实DSH GUI验收。
