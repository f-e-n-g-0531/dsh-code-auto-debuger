# 发布说明

项目采用 MIT License。正式发布使用版本标签触发 GitHub Actions；不需要在本机保存 npm 令牌，也不会自动安装到日常 DSH。

## 发布前验证

需要 Windows x64、Node.js 22 和 .NET 8 SDK。在仓库根目录运行：

```powershell
npm ci
npm run build:bridge
npm run check
npm run test:com
npm run test:bridge
./bridge/ProtocolSmoke.ps1 -BridgePath ./dist/bridge/win-x64/dsh-vs-bridge.exe
npm run verify:package
npm run pack:candidate
npm run test:install
```

候选输出默认位于 `.artifacts/<版本>`。已有包不会被覆盖；重新验证时，设置 `DSH_AUTO_DEBUG_ARTIFACT_DIR` 指向新的输出目录。打包脚本核对源码、桥接文件哈希、运行时许可及归档内容，并生成 SHA256 清单。

## 正式发布流程

1. 更新包版本，核对[测试说明](testing.md)、[安全边界](security.md)和对应验收记录。
2. 提交并推送代码，创建与包版本一致的标签，例如 `v0.1.3`，再推送标签。普通分支推送和 PR 不触发 CI。
3. 发布工作流先运行完整检查、COM 故障注入、协议测试、归档校验和隔离安装，将同一份包保存为构建产物。
4. 仅标签触发的正式发布阶段使用 secret `NPM_AUTOMATION_TOKEN`，将该包发布到 npm `latest`；随后创建 GitHub 正式 Release，附安装包与 SHA256 清单。
5. 核对 Actions 状态、npm 注册表版本和 GitHub Release 下载。公开核验最多等待约 10 分钟，实际下载 npm 包逐字节比对并确认 latest；CLI 返回成功不等于版本已公开。失败时保留原 CI 包，先运行手动只读诊断工作流检查 staged 列表和公开注册表，不盲目重发发布。

手动运行工作流只构建候选，不发布。GitHub 写权限仅授予正式发布 job；测试和打包 job 保持只读权限。仓库必须配置可发布该 npm 包的 automation token；本地 npm 登录不是 CI 发布前置条件。

真实 VS 调试测试仍为独立手动检查。云端测试通过不代表全部调试引擎或当前 DSH GUI 已完成实机验收。
