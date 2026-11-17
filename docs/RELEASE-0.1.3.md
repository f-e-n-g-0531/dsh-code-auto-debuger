# DSH Auto Debug 0.1.3

## 修复

- 修复启用插件时的 `cannot get property "webServer" without inject`：后端显式声明 RPC 注册所需的 webServer 依赖。
- 增加依赖访问回归测试，覆盖注册过程中间接访问未声明服务的情况。
- 改善 npm 发布核验：等待公开版本、下载并逐字节比较安装包，再确认 latest；上传回执不再视作完整发布成功。

## 安装或升级

在 DSH 插件依赖目录安装 `@feng0531/dsh-code-auto-debuger@0.1.3`，保留配置后由用户完全退出并重启 DSH。也可使用本 Release 的固定 tgz 包。使用方式见[README](../README.md)。

## 兼容与限制

Windows x64、标准目录安装的 VS 2022。C++ 严格样例已验证断点命中、源行推进、调用栈和自有断点删除；本轮启用修复通过间接依赖访问回归，不冒充当前真实 GUI 已重新安装验收。C# 和全部扩展调试动作仍未完整验收。

MIT License，允许商业使用。第三方组件保留各自许可。
